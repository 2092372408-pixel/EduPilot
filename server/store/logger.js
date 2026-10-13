/**
 * store/logger.js — 运行日志留存（文件型，JSONL）
 * ------------------------------------------------------------
 * 目的：前端断开/network error/工具被拒等任何异常都可追溯。
 * 每行一条 JSON：{ at, level, tag, sessionId?, msg, data? }
 * 文件：data/logs/runtime-YYYY-MM-DD.jsonl（按天滚动，追加写）
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'data', 'logs');
let _stream = null;

function logFile() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return path.join(LOG_DIR, `runtime-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`);
}

function write(level, tag, msg, data) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      level,
      tag,
      msg,
      data: data !== undefined ? data : undefined,
    };
    // 去掉 undefined 字段，保持 JSON 干净
    for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
    fs.appendFileSync(logFile(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.error('[logger] 写日志失败:', e.message);
  }
}

const logger = {
  info: (tag, msg, data) => write('info', tag, msg, data),
  warn: (tag, msg, data) => write('warn', tag, msg, data),
  error: (tag, msg, data) => write('error', tag, msg, data),
  /** 读取最近 N 条（后台页查看用） */
  tail(n = 50) {
    try {
      const f = logFile();
      if (!fs.existsSync(f)) return [];
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } });
    } catch (_) { return []; }
  },
};

module.exports = logger;
