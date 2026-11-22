/** Project saved learning records; Python aggregates the personal learning home. */
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolvePython } = require('../python');
const registry = require('../kb/course-registry');
const profiles = require('../store/profiles');

const LIMIT = 8 * 1024 * 1024;
const safeObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const text = (value, length = 180) => typeof value === 'string' ? value.slice(0, length) : '';
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function problem(code, status = 503, lang = 'zh') {
  const messages = {
    invalid_uid: ['缺少有效的本地身份，请重新打开应用。', 'A valid local profile is required. Reopen the app.'],
    learning_home_changed: ['学习记录已更新，请刷新主页。', 'Your learning records have changed. Refresh your home.'],
    learning_home_too_large: ['学习记录过大，暂时无法生成主页。', 'The learning records are too large to build this home.'],
    learning_home_unavailable: ['暂时无法生成学习主页，请检查 Python 后重试。', 'Your learning home is unavailable. Check Python and retry.'],
    cancelled: ['已取消加载学习主页。', 'Loading your learning home was cancelled.'],
  };
  return Object.assign(new Error((messages[code] || messages.learning_home_unavailable)[lang === 'en' ? 1 : 0]), { code, status });
}

function validateUid(uid, lang) {
  if (typeof uid !== 'string' || !uid || uid.length > 60 || /[@~\s\x00-\x1f\x7f]/.test(uid)) throw problem('invalid_uid', 400, lang);
  return uid;
}

function projectRecord(value) {
  const rec = safeObject(value);
  const assessment = safeObject(rec.assessment);
  return {
    phase: text(rec.phase, 40), quizTotal: numeric(rec.quizTotal), lastActivity: text(rec.lastActivity, 80),
    assessment: { passed: assessment.passed === true, mode: text(assessment.mode, 30), at: text(assessment.at || assessment.completedAt, 80) },
    review: { dueAt: text(safeObject(rec.review).dueAt, 80) },
    practiceEvidence: list(rec.practiceEvidence).map(value => {
      const e = safeObject(value);
      return { kind: text(e.kind, 40), at: text(e.at, 80) };
    }),
    transferEvidence: list(rec.transferEvidence).map(value => {
      const e = safeObject(value);
      return {
        id: text(e.id), taskId: text(e.taskId), kind: text(e.kind, 40), at: text(e.at, 80), verified: e.verified === true,
        attempt: numeric(e.attempt), assistanceState: text(e.assistanceState, 40), hintsUsed: numeric(e.hintsUsed),
        chatHelpCount: numeric(e.chatHelpCount), answerExposed: typeof e.answerExposed === 'boolean' ? e.answerExposed : null,
        passed: numeric(e.passed), total: numeric(e.total),
      };
    }),
  };
}

function collect({ uid, builtinCourse, sessions, lang }) {
  validateUid(uid, lang);
  const catalog = registry.listDynamicCourses();
  const watched = [];
  const views = [{ view: builtinCourse, source: 'builtin' }, ...catalog.map(meta => ({ view: registry.dynamicCourseView(meta), source: 'upload' }))];
  const courses = views.map(({ view, source }) => {
    const scopeId = uid + '@' + view.id;
    const session = sessions.get(scopeId);
    watched.push({ scopeId, session, generation: session?.scopeGeneration, revision: session?.scopeRevision });
    const learning = session?.activeCourseId === view.id ? safeObject(session.learning) : {};
    const saved = safeObject(learning.kps);
    const records = Object.create(null);
    const chapters = list(view.chapters).map(chapter => ({
      id: text(chapter.id, 160), title: text(chapter.title),
      knowledgePoints: list(chapter.knowledgePoints).map(point => {
        const id = text(point.id, 160);
        records[id] = projectRecord(Object.hasOwn(saved, id) ? saved[id] : null);
        return { id, title: text(point.title) };
      }),
    }));
    return { id: text(view.id, 160), title: text(view.title), source, learningReady: source === 'builtin' || view.learningReady === true,
      currentKpId: text(learning.currentKpId, 160), chapters, records };
  });
  const profile = profiles.getProfile(uid);
  return {
    payload: { now: new Date().toISOString(), profile: { nickname: text(profile?.nickname, 20), avatar: 'edupilot' }, courses },
    assertCurrent() {
      const current = registry.listDynamicCourses();
      if (current.length !== catalog.length || catalog.some(meta => registry.getDynamicCourse(meta.id) !== meta)
          || watched.some(item => sessions.get(item.scopeId) !== item.session
            || item.session?.scopeGeneration !== item.generation || item.session?.scopeRevision !== item.revision)) {
        throw problem('learning_home_changed', 409, lang);
      }
    },
  };
}

function aggregate(payload, { lang = 'zh', signal } = {}) {
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > LIMIT) return Promise.reject(problem('learning_home_too_large', 413, lang));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(problem('cancelled', 499, lang));
    const child = spawn(resolvePython(), ['-I', '-X', 'utf8', path.join(__dirname, 'summary.py')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', bytes = 0, done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(problem('cancelled', 499, lang));
    const timer = setTimeout(() => finish(problem('learning_home_unavailable', 503, lang)), 10000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(problem('learning_home_unavailable', 503, lang)));
    child.stdin.on('error', () => finish(problem('learning_home_unavailable', 503, lang)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      bytes += Buffer.byteLength(data);
      if (bytes > LIMIT) return finish(problem('learning_home_too_large', 413, lang));
      output += data;
    });
    child.stderr.resume();
    child.on('close', code => {
      if (done) return;
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result?.ok !== true || !Array.isArray(result.courses) || !Array.isArray(result.domains)) throw new Error('invalid output');
        finish(null, result);
      } catch (_) { finish(problem('learning_home_unavailable', 503, lang)); }
    });
    child.stdin.end(input);
  });
}

async function buildLearningHome({ uid, lang = 'zh', builtinCourse, sessions, signal }) {
  const snapshot = collect({ uid, lang, builtinCourse, sessions });
  const result = await aggregate(snapshot.payload, { lang, signal });
  snapshot.assertCurrent();
  return result;
}

module.exports = { buildLearningHome, validateUid, projectRecord, aggregate };
