/* 用户档案（昵称/头像）：按 uid 持久化到 data/profiles.json
 * uid = 会话 id 的 @ 前缀（localStorage eduowl_uid，浏览器本地身份，非账号体系）
 * 用途：Agent 系统提示注入昵称称呼、页面头部头像昵称展示
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'data', 'profiles.json');
const AVATARS = new Set(['edupilot']);

let cache = null; // { uid: { nickname, avatar, updatedAt } }

function ensureLoaded() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch (_) {
    cache = {};
  }
  return cache;
}

/** 解析会话/请求中的 uid（@ 前缀；无 @ 视为整串——兼容旧格式本地 uid） */
function uidOf(sessionIdOrUid) {
  const s = String(sessionIdOrUid || '');
  const idx = s.indexOf('@');
  return (idx >= 0 ? s.slice(0, idx) : s).trim().slice(0, 60) || null;
}

/** 取用户档案；无则 null */
function getProfile(uidKey) {
  const uid = uidOf(uidKey);
  if (!uid) return null;
  return ensureLoaded()[uid] || null;
}

/** 昵称（无档案返回 ''） */
function nicknameOf(uidKey) {
  const p = getProfile(uidKey);
  return (p && p.nickname) || '';
}

/** 设置/更新档案（校验昵称长度与头像白名单） */
function setProfile(uidKey, data = {}) {
  const uid = uidOf(uidKey);
  if (!uid) return { ok: false, error: '缺少用户标识' };
  const nickname = String(data.nickname || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (!nickname) return { ok: false, error: '昵称不能为空（1~20 字）' };
  const avatar = AVATARS.has(String(data.avatar || '')) ? String(data.avatar) : 'edupilot';
  const map = ensureLoaded();
  map[uid] = { nickname, avatar, updatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: '档案保存失败: ' + e.message };
  }
  cache = map;
  return { ok: true, profile: map[uid] };
}

module.exports = { getProfile, setProfile, nicknameOf, uidOf, AVATARS: [...AVATARS] };
