/**
 * webconfig.js - local web search settings.
 *
 * The Tavily key is kept in the local .env file and is never returned to the
 * browser. New installs are opt-in through EDUOWL_WEB_ENABLED=0; existing
 * installations with a configured key keep their previous behavior.
 */

require('../env');

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function envFilePath() {
  return process.env.EDUOWL_ENV_FILE || path.join(ROOT, '.env');
}

function maskKey(value) {
  const key = String(value || '');
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 5)}***${key.slice(-4)}`;
}

function writeEnvKeys(pairs) {
  let lines = [];
  try { lines = fs.readFileSync(envFilePath(), 'utf8').split(/\r?\n/); } catch (_) { lines = []; }
  const pending = new Map(Object.entries(pairs).filter(([, value]) => value !== undefined));
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq < 1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });
  if (pending.size) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push('# ---------- Web search (managed by Settings) ----------');
    for (const [key, value] of pending) out.push(`${key}=${value}`);
  }
  fs.writeFileSync(envFilePath(), out.join('\n'), 'utf8');
}

function getConfig() {
  const key = String(process.env.TAVILY_API_KEY || '').trim();
  const flag = process.env.EDUOWL_WEB_ENABLED;
  return {
    // Existing installations that already have a Tavily key keep their
    // previous behavior. New installs get EDUOWL_WEB_ENABLED=0 from the
    // template and therefore remain opt-in.
    enabled: !!key && (flag === '1' || flag === undefined),
    hasKey: !!key,
    keyMasked: maskKey(key),
  };
}

function saveConfig(input = {}) {
  const enabled = input.enabled === true;
  const apiKey = input.apiKey === undefined ? undefined : String(input.apiKey).trim();
  const currentKey = String(process.env.TAVILY_API_KEY || '').trim();
  const nextKey = apiKey === undefined ? currentKey : apiKey;

  if (apiKey !== undefined && apiKey.length > 300) {
    return { ok: false, error: 'Tavily API Key 过长' };
  }
  if (apiKey !== undefined && /[\r\n]/.test(apiKey)) {
    return { ok: false, error: 'Tavily API Key 格式无效' };
  }
  if (enabled && !nextKey) {
    return { ok: false, error: '开启联网搜索前请先填写 Tavily API Key' };
  }

  try {
    writeEnvKeys({
      EDUOWL_WEB_ENABLED: enabled ? '1' : '0',
      ...(apiKey !== undefined ? { TAVILY_API_KEY: apiKey } : {}),
    });
  } catch (error) {
    return { ok: false, error: `写入 .env 失败：${error.message}` };
  }

  process.env.EDUOWL_WEB_ENABLED = enabled ? '1' : '0';
  if (apiKey !== undefined) {
    if (apiKey) process.env.TAVILY_API_KEY = apiKey;
    else delete process.env.TAVILY_API_KEY;
  }
  return { ok: true, config: getConfig() };
}

module.exports = { getConfig, saveConfig, maskKey };
