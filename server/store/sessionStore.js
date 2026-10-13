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
 * 与 LangGraph checkpointer 的关系：本轮不挂 checkpointer——
 * 图每次请求由业务层手动传 messages，双写会冲突；
 * 等需要"长任务中断恢复"时再引入官方 checkpoint。
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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

function save(session) {
  init();
  db.prepare(`
    INSERT INTO sessions (id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(session.id, JSON.stringify(stripTransient(session)), Date.now());
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

module.exports = { init, loadAll, save, remove, count, DB_PATH, getDb: init };
