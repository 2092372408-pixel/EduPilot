/**
 * store/sessionStore.js — 会话持久化（Step C：本地 SQLite）
 * ------------------------------------------------------------
 * 解决"重启即失"：把会话（记忆/学习状态机/轨迹）落盘到 SQLite。
 *
 * 设计（先跑通原则）：
 * - 一张表存整个 session 对象的 JSON（数据量小，查询简单）；
 * - better-sqlite3 同步 API，读写即返回，无需回调/异步；
 * - 未来数据量大/要统计时，再拆 messages/learning 关系表。
 *
 * 图每次请求由业务层传 messages，不另挂 LangGraph checkpointer。
 * Harness 在同一 SQLite 事务中保存已确认业务动作与运行检查点；
 * 恢复会重建模型上下文并复用已确认写动作，不恢复模型内部推理过程。
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

const DB_DIR = path.join(__dirname, '..', '..', 'data');
// 测试隔离：EDUOWL_DB 指向临时库时（自动化测试用独立 DB，避免污染正式会话数据）
const DB_PATH = process.env.EDUOWL_DB || path.join(DB_DIR, 'app.db');

let db = null;

/** 初始化数据库（建表）。幂等，服务启动时调用一次。 */
function init() {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL'); // 写并发友好
  db.pragma('synchronous = FULL'); // 崩溃安全：每笔提交落盘（数据量小，性能无感）
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,          -- 整个 session 对象的 JSON
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_scope_versions (
      scope_id TEXT PRIMARY KEY,
      generation TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    );
  `);
  // 正常退出时 checkpoint WAL，避免强杀丢失最后一笔写
  process.on('exit', () => { try { db.close(); } catch (_) {} });
  return db;
}

/** 启动时加载全部会话（量小，全量载入内存） */
function loadAll() {
  init();
  const rows = db.prepare('SELECT data FROM sessions').all();
  const sessions = new Map();
  for (const row of rows) {
    try {
      const s = JSON.parse(row.data);
      const version = scopeVersion(scopeIdOf(s.id));
      s.scopeGeneration = version.generation;
      s.scopeRevision = version.revision;
      sessions.set(s.id, s);
    } catch (e) {
      console.error('[store] 会话数据损坏，已跳过:', e.message);
    }
  }
  return sessions;
}

/** 保存会话（新增或更新）。每轮对话结束后调用。 */
/**
 * 持久化前剔除"仅本轮有效"的瞬态字段（约定：`_` 前缀）。
 * 这些是引擎/护栏的运行期状态（_graphCalls / _checkedThisTurn / _graphCallCounts /
 * _offTopicSubject / _logger …）。如果不剔除：
 *  ① 会把整轮工具输出（教材片段、联网结果）重复写进库，行体积翻倍；
 *  ② 重启后这些陈旧值会被"读回来"，例如 _checkedThisTurn 残留会让新一轮无法判分。
 */
function stripTransient(session) {
  const out = {};
  for (const [k, v] of Object.entries(session)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

function scopeIdOf(id) { return String(id || 'default').split('~')[0]; }

function scopeVersion(id) {
  init();
  const scope = scopeIdOf(id);
  db.prepare('INSERT OR IGNORE INTO learning_scope_versions(scope_id,generation,revision) VALUES(?,?,0)').run(scope, randomUUID());
  return db.prepare('SELECT generation,revision FROM learning_scope_versions WHERE scope_id=?').get(scope);
}

function conflict(message, code = 'stale_learning_state') {
  return Object.assign(new Error(message), { code, status: 409 });
}

function assertCourseAvailable(session) {
  const cid = session.activeCourseId;
  const registry = require('../kb/course-registry');
  if (cid && registry.isCourseDeleted?.(cid)) {
    throw Object.assign(new Error('课程已删除，请返回课程列表。'), { code: 'course_deleted', status: 410 });
  }
}

function writeRow(id, data) {
  db.prepare(`
    INSERT INTO sessions (id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(id, JSON.stringify(data), Date.now());
}

function read(id) {
  const row = init().prepare('SELECT data FROM sessions WHERE id=?').get(id);
  return row ? JSON.parse(row.data) : null;
}

/** All learning writes pass this compare-and-swap boundary, including legacy tools. */
function save(session, options = {}) {
  init();
  assertCourseAvailable(session);
  const scope = scopeIdOf(session.id);
  const version = db.transaction(() => {
    const current = scopeVersion(scope);
    if (session.scopeGeneration && session.scopeGeneration !== current.generation) {
      throw conflict('学习记录已重置，本次旧操作不能继续。', 'stale_generation');
    }
    if (!options.conversationOnly && session.scopeRevision != null && session.scopeRevision !== current.revision) {
      throw conflict('学习记录已更新，请刷新后重新操作。');
    }
    const canonical = read(scope);
    const data = stripTransient(session);
    if (options.conversationOnly) {
      // The database owns learning. A late chat/summary save cannot restore an old snapshot.
      data.learning = canonical?.learning ?? data.learning;
      data.exam = canonical?.exam;
      data.scopeGeneration = current.generation;
      data.scopeRevision = current.revision;
      if (session.id === scope && canonical) {
        data.courseLearning = canonical.courseLearning;
        data.learningBackup = canonical.learningBackup;
      }
      writeRow(session.id, data);
      return current;
    }
    const next = { generation: current.generation, revision: current.revision + 1 };
    data.scopeGeneration = next.generation;
    data.scopeRevision = next.revision;
    if (scope !== session.id) {
      if (!canonical) throw conflict('课程学习记录不存在，请重新打开课程。');
      canonical.learning = data.learning;
      canonical.exam = data.exam;
      canonical.scopeGeneration = next.generation;
      canonical.scopeRevision = next.revision;
      writeRow(scope, canonical);
    }
    writeRow(session.id, data);
    db.prepare('UPDATE learning_scope_versions SET revision=? WHERE scope_id=? AND generation=?')
      .run(next.revision, scope, current.generation);
    return next;
  })();
  if (!options.conversationOnly) {
    session.scopeGeneration = version.generation;
    session.scopeRevision = version.revision;
  }
  return version;
}

function saveConversation(session) { return save(session, { conversationOnly: true }); }

/** Keep a generation tombstone after reset so in-flight work cannot resurrect records. */
function invalidateScope(id) {
  const scope = scopeIdOf(id);
  scopeVersion(scope);
  init().prepare('UPDATE learning_scope_versions SET generation=?, revision=0 WHERE scope_id=?').run(randomUUID(), scope);
}

/** 删除会话 */
function remove(id) {
  init();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/** 会话数量（后台可显示） */
function count() {
  init();
  return db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
}

module.exports = { init, loadAll, save, saveConversation, read, scopeVersion, invalidateScope, remove, count, DB_PATH, getDb: init };
