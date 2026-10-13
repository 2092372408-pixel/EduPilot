/**
 * attachmentStore.js - chat attachment metadata and local file storage.
 *
 * Binary data is intentionally kept outside session JSON. Sessions only carry
 * small attachment references, while this store owns cleanup and authorization.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sessionStore = require('./sessionStore');
const { convertToMarkdown } = require('../kb/convert');

const ROOT = path.join(__dirname, '..', '..');
const ATTACHMENT_DIR = path.join(ROOT, 'data', 'attachments');
const MAX_MB = Number(process.env.CHAT_ATTACHMENT_MAX_MB) > 0 ? Number(process.env.CHAT_ATTACHMENT_MAX_MB) : 10;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DOCUMENT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.docx', '.pdf', '.pptx']);
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

let initialized = false;

function init() {
  const db = sessionStore.init();
  if (initialized) return db;
  fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      uid           TEXT NOT NULL,
      course_id     TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      size          INTEGER NOT NULL,
      sha256        TEXT NOT NULL,
      storage_path  TEXT NOT NULL,
      extracted_text TEXT,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id, created_at);
  `);
  initialized = true;
  return db;
}

function scopeOf(sessionId) {
  const value = String(sessionId || 'default');
  const at = value.lastIndexOf('@');
  return at > 0 ? { uid: value.slice(0, at), courseId: value.slice(at + 1) } : { uid: value, courseId: 'python-intro' };
}

function safeName(name) {
  return path.basename(String(name || 'attachment')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'attachment';
}

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

function metadata(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.original_name,
    mime: row.mime,
    kind: row.kind,
    size: row.size,
    extracted: !!row.extracted_text,
    createdAt: row.created_at,
  };
}

async function create({ sessionId, filename, mime, data }) {
  const name = safeName(filename);
  const ext = extOf(name);
  const kind = IMAGE_EXT.has(ext) ? 'image' : DOCUMENT_EXT.has(ext) ? 'document' : null;
  if (!kind) throw new Error('不支持的附件格式（支持图片、md/txt/json/docx/pdf/pptx）');
  if (!data || !data.length) throw new Error('附件内容为空');
  if (data.length > MAX_BYTES) throw new Error(`附件过大：超过 ${MAX_MB}MB 上限`);

  const db = init();
  const id = `att-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const storagePath = path.join(ATTACHMENT_DIR, `${id}${ext}`);
  // MIME 以扩展名白名单为准，避免客户端伪造类型后把任意 data URL 交给模型。
  const normalizedMime = MIME_BY_EXT[ext] || String(mime || '').split(';')[0].trim() || 'application/octet-stream';
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  let extractedText = null;
  try {
    fs.writeFileSync(storagePath, data, { flag: 'wx' });
    if (kind === 'document') {
      const converted = await convertToMarkdown(storagePath, { fallbackTitle: name.replace(/\.[^.]+$/, '') });
      extractedText = String(converted.markdown || '').slice(0, 120000);
      if (!extractedText.trim()) throw new Error('附件未提取出可用文字');
    }
    const scope = scopeOf(sessionId);
    const now = Date.now();
    db.prepare(`INSERT INTO attachments
      (id,session_id,uid,course_id,original_name,mime,kind,size,sha256,storage_path,extracted_text,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, String(sessionId || 'default'), scope.uid, scope.courseId, name, normalizedMime, kind, data.length, hash, storagePath, extractedText, now, null);
    return { ...metadata({ id, original_name: name, mime: normalizedMime, kind, size: data.length, extracted_text: extractedText, created_at: now }), extractedText: extractedText ? extractedText.slice(0, 16000) : null };
  } catch (e) {
    try { fs.rmSync(storagePath, { force: true }); } catch (_) {}
    throw e;
  }
}

function getForSession(sessionId, ids = []) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '')).filter(Boolean))];
  if (!list.length) return [];
  const db = init();
  const marks = list.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM attachments WHERE session_id=? AND id IN (${marks})`).all(String(sessionId || 'default'), ...list);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return list.map((id) => byId.get(id)).filter(Boolean);
}

function toContentPart(row) {
  if (!row || row.kind !== 'image' || !fs.existsSync(row.storage_path)) return null;
  const data = fs.readFileSync(row.storage_path).toString('base64');
  return { type: 'image_url', image_url: { url: `data:${row.mime};base64,${data}` } };
}

function clearSession(sessionId) {
  const db = init();
  const rows = db.prepare('SELECT storage_path FROM attachments WHERE session_id=?').all(String(sessionId || 'default'));
  for (const row of rows) {
    try { fs.rmSync(row.storage_path, { force: true }); } catch (_) {}
  }
  return db.prepare('DELETE FROM attachments WHERE session_id=?').run(String(sessionId || 'default')).changes;
}

module.exports = { init, create, getForSession, metadata, toContentPart, clearSession, ATTACHMENT_DIR, MAX_BYTES, MAX_MB };
