/**
 * embed.js — 文本向量化（多 provider 可插拔）
 * ------------------------------------------------------------
 * 把文本转成向量：语义相近的文本，向量距离近。
 *
 * Provider 选择（.env EMBED_PROVIDER）：
 *   local      （默认）fastembed 本地模型 bge-small-zh-v1.5（512 维）
 *              零成本 / 离线 / 无限次，长驻子进程避免反复加载模型
 *   dashscope  Qwen text-embedding-v3（1024 维，需 DASHSCOPE_API_KEY）
 *   siliconflow BAAI/bge-m3（1024 维，需 SILICONFLOW_API_KEY，官方免费档）
 *   auto       local 不可用时自动回退 dashscope（再失败回退 BM25）
 *
 * 容错：provider 初始化/调用失败时返回 null，检索层自动回退纯 BM25。
 * 注意：不同 provider 维度不同，切换后需重建各课程 vectors.json。
 */

require('../env');

const path = require('path');
const { spawn } = require('child_process');

const EMBED_PROVIDER = (process.env.EMBED_PROVIDER || 'local').toLowerCase();

/* ---------- 本地 provider（fastembed 长驻子进程） ---------- */
const LOCAL_SCRIPT = path.join(__dirname, 'embed_local.py');

/** 候选 Python 解释器（优先项目 venv，其次 PATH） */
function findPython() {
  const root = path.join(__dirname, '..', '..');
  const cands = [
    process.env.EMBED_PYTHON,
    process.env.PYTHON_BIN,
    process.env.EDUOWL_PYTHON,
    path.join(root, '.venv-upload', 'Scripts', 'python.exe'), // Windows venv
    path.join(root, '.venv-upload', 'bin', 'python'),          // Linux/macOS venv
    'python',
  ].filter(Boolean);
  return cands;
}

let localProc = null;
let localReady = null;   // Promise：进程就绪
let localBooted = false; // 进程已完成模型加载（stderr 就绪标志已收到）
let localQueue = [];     // 等待响应的请求
let localSeq = 0;
let localDead = false;   // 启动失败后不再重试（本会话内）

/** 启动（或复用）本地向量化长驻进程；返回就绪 Promise */
function ensureLocalProc() {
  if (localReady) return localReady;
  if (localDead) return Promise.reject(new Error('本地向量化不可用（之前启动失败）'));
  localReady = new Promise((resolve, reject) => {
    const py = findPython()[0];
    const proc = spawn(py, [LOCAL_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    localProc = proc;

    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        const waiter = localQueue.find((w) => w.id === msg.id);
        if (waiter) {
          localQueue = localQueue.filter((w) => w.id !== msg.id);
          if (msg.error) waiter.reject(new Error(msg.error));
          else waiter.resolve(msg.vectors);
        }
      }
    });

    // 超时兜底：等 stderr 的"模型就绪"标志（加载约 2~5s；首次含下载放宽到 60s）
    const bootTimer = setTimeout(() => {
      if (localBooted) return; // 已就绪则忽略（resolve 后也可能触发？不会，resolve 后 clearTimeout）
      console.warn('[embed] 本地模型加载超时（60s），本次回退备用 provider/BM25');
      localReady = null;
      localBooted = false;
      try { proc.kill(); } catch (_) {}
      localProc = null;
      localDead = true;
      reject(new Error('本地模型加载超时'));
    }, 60000);

    proc.stderr.on('data', (d) => {
      const text = d.toString('utf8');
      // 就绪标志出现在 stderr 日志中
      if (!localBooted && /模型就绪/.test(text)) {
        localBooted = true;
        clearTimeout(bootTimer);
        resolve(true);
      }
      console.log('[embed_local]', text.trim().slice(0, 200));
    });
    proc.on('error', (e) => {
      clearTimeout(bootTimer);
      localReady = null;
      localBooted = false;
      localProc = null;
      localDead = true;
      reject(e);
    });
    proc.on('exit', (code) => {
      // 进程意外退出：清空待处理请求（下次调用自动重启）
      const wasBooted = localBooted;
      clearTimeout(bootTimer);
      if (!wasBooted) {
        localDead = true;
        reject(new Error('本地向量化进程在就绪前退出 code=' + code));
      }
      localProc = null;
      localReady = null;
      localBooted = false;
      if (wasBooted) console.warn('[embed] 本地向量化进程退出 code=' + code + '（下次调用自动重启）');
      const q = localQueue;
      localQueue = [];
      q.forEach((w) => w.reject(new Error('本地向量化进程退出')));
    });
  });
  return localReady;
}

/**
 * 本地向量化一批文本。
 * 注意两个曾经的坑：
 *  ① `reject` 原先定义在 Promise executor 的箭头参数里，setTimeout 回调访问不到它，
 *     超时触发时抛 "ReferenceError: reject is not defined" → 进程级未捕获异常 → 服务退出。
 *     这也是"上传中大文件就把服务搞崩"的直接原因。这里显式捕获 resolve/reject。
 *  ② 原先整批文本**一次性**发给本地进程（无分批），大教材（上千块）单次请求会超过 30s
 *     超时并触发上面的崩溃。现按 LOCAL_BATCH 分批串行请求。
 */
const LOCAL_BATCH = 32; // 单次请求的文本数（本地推理很快，分批只为避免超时与管道拥塞）
/** 单批超时（毫秒）：默认 30s；EMBED_TIMEOUT_MS 可覆盖（慢机器调大，测试调小） */
const LOCAL_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS) > 0 ? Number(process.env.EMBED_TIMEOUT_MS) : 30000;

function embedLocalOnce(texts) {
  const id = ++localSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      localQueue = localQueue.filter((w) => w.id !== id);
      reject(new Error('本地向量化请求超时'));
    }, LOCAL_TIMEOUT_MS);
    localQueue.push({
      id,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      localProc.stdin.write(JSON.stringify({ id, texts }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      localQueue = localQueue.filter((w) => w.id !== id);
      reject(e);
    }
  });
}

async function embedLocal(texts, onProgress) {
  await ensureLocalProc();
  if (!localProc) throw new Error('本地向量化进程不可用');
  const out = [];
  for (let i = 0; i < texts.length; i += LOCAL_BATCH) {
    const part = await embedLocalOnce(texts.slice(i, i + LOCAL_BATCH));
    if (!part) return null;
    for (const v of part) out.push(v);
    if (onProgress) onProgress({ completed: out.length, total: texts.length });
  }
  return out;
}

/* ---------- 云端 provider（OpenAI 兼容 embeddings 端点） ---------- */

async function embedApi(texts, cfg) {
  const { key, base, model } = cfg;
  if (!key) return null;
  const results = [];
  for (let i = 0; i < texts.length; i += 10) {
    const batch = texts.slice(i, i + 10);
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) {
      console.error('[embed] API 失败:', res.status, (await res.text()).slice(0, 120));
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data.data) || data.data.length !== batch.length) return null;
    const seen = new Set();
    for (const item of data.data) {
      if (!Number.isInteger(item.index) || item.index < 0 || item.index >= batch.length || seen.has(item.index)
        || !Array.isArray(item.embedding) || !item.embedding.length || !item.embedding.every(Number.isFinite)
        || (results[0] && item.embedding.length !== results[0].length)) return null;
      seen.add(item.index);
      results[i + item.index] = item.embedding;
    }
    const dimension = results[i].length;
    if (results.slice(i).some(vector => vector.length !== dimension)) return null;
  }
  return results;
}

function apiConfigs() {
  return [
    { name: 'dashscope', key: process.env.DASHSCOPE_API_KEY, base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3' },
    { name: 'siliconflow', key: process.env.SILICONFLOW_API_KEY, base: 'https://api.siliconflow.cn/v1', model: process.env.EMBED_MODEL || 'BAAI/bge-m3' },
  ];
}

/**
 * 批量向量化（provider 路由 + 容错链）
 * @param {string[]} texts
 * @returns {Promise<number[][]|null>} null = 全部 provider 不可用（调用方回退 BM25）
 */
async function embedTexts(texts, opts = {}) {
  if (!texts || !texts.length) return [];
  // 显式 provider
  if (EMBED_PROVIDER === 'local') {
    try { return await embedLocal(texts, opts.onProgress); } catch (e) { console.warn('[embed] local 失败:', e.message); return null; }
  }
  if (EMBED_PROVIDER === 'dashscope') {
    return embedApi(texts, apiConfigs()[0]);
  }
  if (EMBED_PROVIDER === 'siliconflow') {
    return embedApi(texts, apiConfigs()[1]);
  }
  // auto：本地优先，失败依次回退云端 API
  try {
    const v = await embedLocal(texts, opts.onProgress);
    if (v) return v;
  } catch (e) {
    console.warn('[embed] local 失败，尝试云端 API:', e.message);
  }
  for (const cfg of apiConfigs()) {
    const v = await embedApi(texts, cfg);
    if (v) return v;
  }
  return null;
}

/** 余弦相似度（两个等长向量，-1~1，越大越相似） */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 0 : dot / norm;
}

/** 关闭本地长驻进程（服务退出/测试用） */
function closeLocal() {
  if (localProc) { try { localProc.kill(); } catch (_) {} localProc = null; }
  localReady = null;
}

module.exports = { embedTexts, cosine, closeLocal, EMBED_PROVIDER };
