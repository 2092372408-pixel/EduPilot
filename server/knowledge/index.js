/** Python owns graph construction and relation policy; this adapter owns I/O. */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { resolvePython } = require('../python');
const sessionStore = require('../store/sessionStore');
const registry = require('../kb/course-registry');
const ownerQueues = new Map();
const LIMIT = 4 * 1024 * 1024;

function problem(code, status = 400) {
  const error = new Error(code); error.code = code; error.status = status; return error;
}
function ownerOf(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 300 || /[\x00-\x1f]/.test(sessionId)) throw problem('invalid_session');
  return sessionId.split('@')[0].split('~')[0];
}
function db() {
  const connection = sessionStore.getDb();
  connection.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_links (
      owner TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
      source_course TEXT NOT NULL, target_course TEXT NOT NULL, relation TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, PRIMARY KEY(owner,id)
    );
    CREATE INDEX IF NOT EXISTS knowledge_links_course ON knowledge_links(source_course,target_course);
    CREATE TABLE IF NOT EXISTS knowledge_notes (
      owner TEXT NOT NULL, node_id TEXT NOT NULL, course_id TEXT NOT NULL,
      text TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner,node_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_versions (owner TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
  `);
  return connection;
}
function serial(owner, fn) {
  const previous = ownerQueues.get(owner) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  ownerQueues.set(owner, next);
  return next.finally(() => { if (ownerQueues.get(owner) === next) ownerQueues.delete(owner); });
}
function revision(owner) { return db().prepare('SELECT version FROM knowledge_versions WHERE owner=?').get(owner)?.version || 0; }
function bump(owner) { db().prepare('INSERT INTO knowledge_versions(owner,version) VALUES (?,1) ON CONFLICT(owner) DO UPDATE SET version=version+1').run(owner); }
function customizations(owner) {
  return {
    links: db().prepare('SELECT id,source,target,relation,note FROM knowledge_links WHERE owner=? ORDER BY updated_at,id LIMIT 1000').all(owner),
    notes: db().prepare('SELECT node_id AS nodeId,text FROM knowledge_notes WHERE owner=? ORDER BY node_id LIMIT 1000').all(owner),
  };
}
const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const number = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1000000, Number(value))) : 0;

// The Python process and browser never receive quiz answers, full tasks, code,
// reference implementations, private chat history, or model credentials.
function projectCourses(courses) {
  if (!Array.isArray(courses)) throw problem('invalid_courses');
  return courses.slice(0, 64).map(item => {
    const view = item.course || {};
    const kps = Object.create(null);
    const chapters = (Array.isArray(view.chapters) ? view.chapters : []).slice(0, 200).map(chapter => ({
      id: str(chapter.id, 160), title: str(chapter.title, 180),
      knowledgePoints: (Array.isArray(chapter.knowledgePoints) ? chapter.knowledgePoints : []).slice(0, 2000).map(point => {
        const rec = item.learning?.kps?.[point.id] || {};
        kps[point.id] = {
          phase: str(rec.phase, 40), quizTotal: number(rec.quizTotal), quizCorrect: number(rec.quizCorrect),
          assessment: rec.assessment ? { mode: str(rec.assessment.mode, 30), passed: rec.assessment.passed === true, at: str(rec.assessment.at || rec.assessment.completedAt, 80) } : null,
          review: { dueAt: str(rec.review?.dueAt, 80) }, lastActivity: str(rec.lastActivity, 80),
          quizHistory: (Array.isArray(rec.quizHistory) ? rec.quizHistory : []).slice(-5).map(q => ({ correct: q?.correct === true ? true : q?.correct === false ? false : null, at: str(q?.at, 80) })),
          practiceEvidence: (Array.isArray(rec.practiceEvidence) ? rec.practiceEvidence : []).slice(-50).map(e => ({
            kind: str(e?.kind, 40), correct: e?.correct === true, at: str(e?.at, 80), verified: e?.verified === true,
          })),
          transferEvidence: (Array.isArray(rec.transferEvidence) ? rec.transferEvidence : []).slice(-50).map(e => ({
            kind: str(e?.kind, 40), verified: e?.verified === true,
            ruleVersion: typeof e?.ruleVersion === 'number' ? String(e.ruleVersion) : str(e?.ruleVersion, 40),
          })),
        };
        const sources = (Array.isArray(point.sources) ? point.sources : []).slice(0, 8).map(source => {
          if (typeof source === 'string') return source.slice(0, 400);
          if (!source || typeof source !== 'object') return {};
          return Object.fromEntries(['docId', 'title', 'chapter', 'section', 'page', 'chunkId'].filter(k => source[k] != null).map(k => [k, String(source[k]).slice(0, 400)]));
        });
        return { id: str(point.id, 160), title: str(point.title, 180), summary: str(point.summary, 1200),
          keyPoints: (Array.isArray(point.keyPoints) ? point.keyPoints : []).slice(0, 8).map(p => str(p, 300)), sources };
      }),
    }));
    return { course: { id: str(view.id, 160), title: str(view.title, 180), description: str(view.description, 1000), chapters }, learning: { kps } };
  });
}

function python(payload, signal) {
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > LIMIT) return Promise.reject(problem('graph_too_large', 413));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(problem('cancelled', 499));
    const child = spawn(resolvePython(), [path.join(__dirname, 'graph.py')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', bytes = 0, errors = '', done = false;
    const finish = (error, value) => {
      if (done) return; done = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(problem('cancelled', 499));
    const timer = setTimeout(() => finish(problem('graph_timeout', 503)), 10000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(problem('python_unavailable', 503)));
    child.stdin.on('error', () => finish(problem('graph_worker_failed', 503)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { bytes += Buffer.byteLength(data); if (bytes > LIMIT) return finish(problem('graph_too_large', 413)); output += data; });
    child.stderr.on('data', data => { if (errors.length < 1000) errors += data.toString('utf8'); });
    child.on('close', code => {
      if (done) return;
      try {
        const result = JSON.parse(output);
        if (code !== 0) return finish(problem(result.code || 'graph_worker_failed', 503));
        finish(null, result);
      } catch (_) { finish(problem('graph_worker_failed', 503)); }
    });
    child.stdin.end(input);
  });
}

function assertAvailable(courseIds, assertCurrent) {
  assertCurrent?.();
  for (const id of courseIds) {
    if (id !== 'python-intro' && !registry.getDynamicCourse(id)) throw problem('course_not_found', 409);
  }
}

async function buildPersonalGraph({ sessionId, courses, lang = 'zh', signal }) {
  const owner = ownerOf(sessionId);
  const projected = projectCourses(courses);
  const totalAvailableConcepts = courses.reduce((total, item) => total + (Array.isArray(item.course?.chapters) ? item.course.chapters : [])
    .reduce((count, chapter) => count + (Array.isArray(chapter.knowledgePoints) ? chapter.knowledgePoints.length : 0), 0), 0);
  const result = await python({ command: 'build', courses: projected, lang, totalAvailableCourses: courses.length,
    totalAvailableConcepts, ...customizations(owner) }, signal);
  if (!result.ok) throw problem(result.code || 'graph_worker_failed', 503);
  return result;
}

async function upsertLink({ sessionId, courses, source, target, relation = 'related', note = '', signal, assertCurrent }) {
  const owner = ownerOf(sessionId);
  if (![source, target, relation, note].every(v => typeof v === 'string') || source.length > 600 || target.length > 600 || note.length > 500) throw problem('invalid_relation');
  return serial(owner, async () => {
    const version = revision(owner);
    const result = await python({ command: 'validate_link', courses: projectCourses(courses), ...customizations(owner), link: { source, target, relation, note } }, signal);
    if (!result.ok) throw problem(result.code);
    const link = result.link;
    assertAvailable([link.sourceCourse, link.targetCourse], assertCurrent);
    return db().transaction(() => {
      if (version !== revision(owner)) throw problem('graph_changed', 409);
      const existing = db().prepare('SELECT id FROM knowledge_links WHERE owner=? AND id=?').get(owner, link.id);
      if (!existing && db().prepare('SELECT COUNT(*) AS n FROM knowledge_links WHERE owner=?').get(owner).n >= 1000) throw problem('link_limit', 409);
      db().prepare(`INSERT INTO knowledge_links(owner,id,source,target,source_course,target_course,relation,note,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at`)
        .run(owner, link.id, link.source, link.target, link.sourceCourse, link.targetCourse, link.relation, link.note, Date.now());
      bump(owner);
      return { ok: true, link: { id: link.id, source: link.source, target: link.target, relation: link.relation, note: link.note, provenance: 'personal', confirmed: true, editable: true } };
    })();
  });
}

function deleteLink({ sessionId, linkId, assertCurrent }) {
  const owner = ownerOf(sessionId);
  if (typeof linkId !== 'string' || linkId.length > 100) throw problem('invalid_relation');
  return db().transaction(() => {
    assertCurrent?.();
    const result = db().prepare('DELETE FROM knowledge_links WHERE owner=? AND id=?').run(owner, linkId);
    if (result.changes) bump(owner);
    return { ok: true, deleted: result.changes > 0 };
  })();
}

async function upsertNote({ sessionId, courses, nodeId, text: note = '', signal, assertCurrent }) {
  const owner = ownerOf(sessionId);
  if (typeof note !== 'string' || note.length > 2000 || typeof nodeId !== 'string') throw problem('invalid_note');
  return serial(owner, async () => {
    const version = revision(owner);
    const graph = await buildPersonalGraph({ sessionId, courses, signal });
    const node = graph.nodes.find(n => n.id === nodeId && n.kind === 'concept');
    if (!node) throw problem('unknown_concept');
    assertAvailable([node.courseId], assertCurrent);
    return db().transaction(() => {
      if (version !== revision(owner)) throw problem('graph_changed', 409);
      if (note.trim()) db().prepare(`INSERT INTO knowledge_notes(owner,node_id,course_id,text,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(owner,node_id) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at`).run(owner, nodeId, node.courseId, note.trim(), Date.now());
      else db().prepare('DELETE FROM knowledge_notes WHERE owner=? AND node_id=?').run(owner, nodeId);
      bump(owner);
      return { ok: true, nodeId, text: note.trim() };
    })();
  });
}

/** Course removal is synchronous, can participate in the caller's transaction. */
function removeCourse(courseId, ownerId = null) {
  const connection = db();
  return connection.transaction(() => {
    const suffix = ownerId == null ? '' : ' AND owner=?';
    const args = ownerId == null ? [courseId, courseId] : [courseId, courseId, ownerId];
    const owners = connection.prepare('SELECT DISTINCT owner FROM knowledge_links WHERE (source_course=? OR target_course=?)' + suffix).all(...args)
      .concat(connection.prepare('SELECT DISTINCT owner FROM knowledge_notes WHERE course_id=?' + suffix).all(...(ownerId == null ? [courseId] : [courseId, ownerId])));
    const links = connection.prepare('DELETE FROM knowledge_links WHERE (source_course=? OR target_course=?)' + suffix).run(...args).changes;
    const notes = connection.prepare('DELETE FROM knowledge_notes WHERE course_id=?' + suffix).run(...(ownerId == null ? [courseId] : [courseId, ownerId])).changes;
    for (const owner of new Set(owners.map(row => row.owner))) bump(owner);
    return { links, notes };
  })();
}

module.exports = { buildPersonalGraph, upsertLink, deleteLink, upsertNote, removeCourse, ownerOf, projectCourses };
