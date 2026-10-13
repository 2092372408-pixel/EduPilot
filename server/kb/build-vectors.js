/**
 * build-vectors.js — 向量索引构建脚本（Step D）
 * ------------------------------------------------------------
 * 用法：node server/kb/build-vectors.js [courseId]
 * 流程：读 chunks.json → 复用未变内容的本地向量 → 计算新增内容 → 写 vectors.json
 *
 * vectors.json 结构不变：{ "chunkId": [向量], ... }；默认本地模型 512 维。
 * vectors.meta.json 记录模型、输入哈希和向量文件校验和；旧索引首次重建时全量计算。
 * 容错：本地无需密钥；向量化失败时降级 BM25。
 */

require('../env');

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { embedTexts, EMBED_PROVIDER } = require('./embed');

const KB_ROOT = path.join(__dirname, '..', '..', 'data', 'kb');

const hash = (text) => createHash('sha256').update(text).digest('hex');
const validVector = (v, dimension) => Array.isArray(v) && v.length > 0
  && (!dimension || v.length === dimension) && v.every(Number.isFinite);

function readCache(outPath, metaPath, model) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.version !== 1 || meta.model !== model || meta.provider !== 'local' || !meta.dimension) return null;
    const raw = fs.readFileSync(outPath, 'utf8');
    // 两个文件没有同时保存成功（或被修改）时，旧哈希绝不能配上新向量。
    if (meta.vectorsHash !== hash(raw)) return null;
    const vectors = JSON.parse(raw);
    const entries = Object.entries(meta.hashes);
    if (entries.length !== Object.keys(vectors).length) return null;
    const byHash = new Map();
    let dimension;
    for (const [id, inputHash] of entries) {
      const v = vectors[id];
      if (typeof inputHash !== 'string' || !validVector(v, dimension)) return null;
      dimension = v.length;
      if (dimension !== meta.dimension) return null;
      byHash.set(inputHash, v);
    }
    return { hashes: meta.hashes, byHash, dimension };
  } catch (_) {
    return null; // 无缓存、旧格式或损坏缓存：重新计算，检索文件格式不变。
  }
}

async function buildVectors(courseId, opts = {}) {
  const directory = opts.directory || path.join(KB_ROOT, 'chunks', courseId);
  const chunksPath = path.join(directory, 'chunks.json');
  if (!fs.existsSync(chunksPath)) {
    console.error(`❌ 未找到切块文件: ${chunksPath}（先运行 node server/kb/import.js）`);
    if (require.main === module) process.exit(1);
    return { ok: false, error: 'chunks.json 不存在' };
  }
  const chunks = JSON.parse(fs.readFileSync(chunksPath, 'utf8'));
  // 只在 provider 真需要密钥时才拦截：默认用的是**本地 fastembed（无需密钥）**，
  // 原实现无条件要求 DASHSCOPE_API_KEY，导致新装的默认配置下向量索引从不构建、
  // 语义检索静默缺失（BM25-only）。这里改为按实际 provider 判断。
  const provider = EMBED_PROVIDER;
  const needKey = { dashscope: 'DASHSCOPE_API_KEY', siliconflow: 'SILICONFLOW_API_KEY' }[provider];
  if (needKey && !process.env[needKey]) {
    console.log(`⚠️ EMBED_PROVIDER=${provider} 但未配置 ${needKey}，跳过向量化（检索将使用纯 BM25）`);
    return { ok: false, skipped: true, reason: `no ${needKey}` };
  }

  const model = embedModel(provider);
  const outPath = path.join(directory, 'vectors.json');
  const metaPath = path.join(directory, 'vectors.meta.json');
  const contents = chunks.map((c) => `【${c.chapter}${c.section ? ' / ' + c.section : ''}】${c.content}`);
  const hashes = contents.map(hash);
  // auto 可能在本地和云端之间回退，不能把来源不确定的向量跨构建复用。
  const cache = provider === 'local' ? readCache(outPath, metaPath, model) : null;
  const byHash = cache ? cache.byHash : new Map();
  const pending = new Map();
  let reused = 0;
  hashes.forEach((h, i) => {
    if (byHash.has(h)) reused++;
    else pending.set(h, contents[i]); // 完全相同的输入只推理一次，仍保留全部检索块。
  });
  const stats = { count: chunks.length, embedded: pending.size, reused, deduplicated: chunks.length - reused - pending.size };
  let completed = 0;
  const reportProgress = (n) => {
    completed = n;
    if (opts.onProgress) opts.onProgress({ stage: 'embedding', completed: n, total: pending.size, reused, deduplicated: stats.deduplicated });
  };
  reportProgress(0);
  console.log(`开始向量化 ${chunks.length} 个切块（${provider}: ${model}）：计算 ${pending.size}，复用 ${reused}...`);
  if (cache && Object.keys(cache.hashes).length === chunks.length
    && chunks.every((c, i) => cache.hashes[c.chunkId] === hashes[i])) {
    return { ok: true, ...stats }; // 内容及编号均未变，连向量文件也无需重写。
  }

  const vectors = pending.size ? await embedTexts([...pending.values()], {
    onProgress: (p) => reportProgress(p.completed),
  }) : [];
  const dimension = (cache && cache.dimension) || (vectors && vectors[0] && vectors[0].length);
  if (!Array.isArray(vectors) || vectors.length !== pending.size || !vectors.every((v) => validVector(v, dimension))) {
    // 关键：被服务进程内调用（上传/建课）时绝不能 process.exit——会杀死整个 HTTP 服务！
    // 向量化失败只降级为纯 BM25 检索，课程依然可用。
    console.error('⚠️ 向量化失败，跳过向量索引——检索将降级为纯 BM25');
    if (require.main === module) process.exit(1);
    return { ok: false, error: '向量计算失败，已降级 BM25' };
  }
  if (completed !== pending.size) reportProgress(pending.size);
  [...pending.keys()].forEach((h, i) => byHash.set(h, vectors[i]));

  const map = {};
  chunks.forEach((c, i) => { map[c.chunkId] = byHash.get(hashes[i]); });
  const raw = JSON.stringify(map);
  fs.writeFileSync(outPath, raw, 'utf8');
  if (provider !== 'auto') {
    try {
      fs.writeFileSync(metaPath, JSON.stringify({
        version: 1, model, provider, dimension, vectorsHash: hash(raw),
        hashes: Object.fromEntries(chunks.map((c, i) => [c.chunkId, hashes[i]])),
      }), 'utf8');
    } catch (e) {
      console.warn('⚠️ 向量复用信息保存失败，下次构建将重新校验或计算:', e.message);
    }
  }
  console.log(`✅ 向量索引已生成: ${outPath}（${chunks.length} 条 × ${dimension || 0} 维）`);
  return { ok: true, ...stats };
}

function embedModel(provider) {
  if (provider === 'local') return process.env.EMBED_MODEL || 'BAAI/bge-small-zh-v1.5';
  if (provider === 'siliconflow') return process.env.EMBED_MODEL || 'BAAI/bge-m3';
  if (provider === 'dashscope') return 'text-embedding-v3';
  return '自动选择';
}

if (require.main === module) { buildVectors(process.argv[2] || 'python-intro'); }
module.exports = { buildVectors };
