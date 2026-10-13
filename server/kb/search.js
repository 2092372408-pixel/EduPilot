/** Course-scoped BM25 and validated dense retrieval, fused by reciprocal rank. */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { embedTexts, cosine, EMBED_PROVIDER } = require('./embed');
const registry = require('./course-registry');
const { courseFiles, KB_ROOT } = require('./snapshots');
const cache = new Map();
const hash = text => createHash('sha256').update(text).digest('hex');

// Memory retrieval keeps its original unique-token contract. BM25 retains term frequency.
function tokenize(text, unique = true) {
  const t = String(text || '').toLowerCase();
  const tokens = t.match(/[a-z0-9_]+|[\u4e00-\u9fa5]/g) || [];
  for (const segment of t.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i < segment.length - 1; i++) tokens.push(segment.slice(i, i + 2));
  }
  return unique ? [...new Set(tokens)] : tokens;
}

function statistics(chunks) {
  const df = new Map();
  const documents = chunks.map(chunk => {
    const tokens = tokenize(chunk.content, false);
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) || 0) + 1);
    return { chunk, tf, length: tokens.length };
  });
  return { documents, df, average: documents.reduce((n, d) => n + d.length, 0) / chunks.length || 1 };
}

function vectorIndex(directory, chunks) {
  try {
    // Auto may choose a different provider for each request; do not mix unidentified spaces.
    if (EMBED_PROVIDER === 'auto') return null;
    const meta = JSON.parse(fs.readFileSync(path.join(directory, 'vectors.meta.json'), 'utf8'));
    const model = EMBED_PROVIDER === 'local' ? process.env.EMBED_MODEL || 'BAAI/bge-small-zh-v1.5'
      : EMBED_PROVIDER === 'siliconflow' ? process.env.EMBED_MODEL || 'BAAI/bge-m3' : 'text-embedding-v3';
    const raw = fs.readFileSync(path.join(directory, 'vectors.json'), 'utf8');
    if (meta.version !== 1 || meta.model !== model || meta.provider !== EMBED_PROVIDER || meta.vectorsHash !== hash(raw)) return null;
    const vectors = JSON.parse(raw);
    if (Object.keys(vectors).length !== chunks.length || Object.keys(meta.hashes).length !== chunks.length) return null;
    for (const c of chunks) {
      const input = `【${c.chapter}${c.section ? ' / ' + c.section : ''}】${c.content}`;
      const v = vectors[c.chunkId];
      if (meta.hashes[c.chunkId] !== hash(input) || !Array.isArray(v) || !v.length
        || v.length !== meta.dimension || !v.every(Number.isFinite)) return null;
    }
    return vectors;
  } catch (_) { return null; }
}

function loadKB(courseId = 'python-intro') {
  const meta = registry.getDynamicCourse(courseId);
  const version = meta?.indexVersion || null;
  if (cache.has(courseId) && cache.get(courseId).version === version) return cache.get(courseId);
  const directory = courseFiles(courseId, meta).chunks;
  if (!fs.existsSync(path.join(directory, 'chunks.json'))) { cache.delete(courseId); return null; }
  const chunks = JSON.parse(fs.readFileSync(path.join(directory, 'chunks.json'), 'utf8'));
  if (meta) for (const c of chunks) {
    if (!c.kpId) c.kpId = registry.learningKey(c.docId, c.chapter, c.section || '');
  }
  let index = null;
  const indexPath = path.join(directory, 'index.json');
  const legacy = path.join(KB_ROOT, 'index.json');
  if (fs.existsSync(indexPath)) index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  else if (courseId === 'python-intro' && fs.existsSync(legacy)) index = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  const kb = { version, index, chunks, vectors: vectorIndex(directory, chunks), statistics: statistics(chunks), byId: new Map(chunks.map(c => [c.chunkId, c])) };
  cache.set(courseId, kb);
  return kb;
}

function ranks(kb, query, kpId) {
  const queryTokens = tokenize(query);
  const { documents, df, average } = kb.statistics;
  const N = documents.length;
  return documents.filter(d => !kpId || d.chunk.kpId === kpId).map(d => {
    let score = 0;
    for (const token of queryTokens) {
      const tf = d.tf.get(token) || 0;
      if (!tf) continue;
      const frequency = df.get(token);
      const idf = Math.log(1 + (N - frequency + 0.5) / (frequency + 0.5));
      score += idf * tf * 2.5 / (tf + 1.5 * (0.25 + 0.75 * d.length / average));
    }
    return { id: d.chunk.chunkId, score };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score);
}

function results(kb, ids, engine, scores = new Map()) {
  return ids.map(id => {
    const c = kb.byId.get(id);
    return { ...c, indexVersion: kb.version, score: scores.get(id) || 0, source: `《${c.docId}》·${c.chapter}`, engine };
  });
}

function search(query, opts = {}) {
  const kb = loadKB(opts.courseId || 'python-intro');
  if (!kb) return [];
  const ranked = ranks(kb, query, opts.kpId);
  return results(kb, ranked.slice(0, opts.topK ?? 3).map(r => r.id), 'bm25', new Map(ranked.map(r => [r.id, r.score])));
}

async function searchHybrid(query, opts = {}) {
  // Pin one immutable snapshot before the first await, including its BM25 statistics.
  const kb = loadKB(opts.courseId || 'python-intro');
  if (!kb) return [];
  const topK = opts.topK ?? 3;
  const sparse = ranks(kb, query, opts.kpId).map(r => r.id);
  if (kb.vectors) {
    const [qVec] = await embedTexts([String(query)]).catch(() => null) || [];
    const dimension = Object.values(kb.vectors)[0]?.length;
    if (Array.isArray(qVec) && qVec.length === dimension && qVec.every(Number.isFinite)) {
      const dense = kb.chunks.filter(c => !opts.kpId || c.kpId === opts.kpId)
        .map(c => ({ id: c.chunkId, sim: cosine(qVec, kb.vectors[c.chunkId]) }))
        .filter(c => c.sim > 0.15).sort((a, b) => b.sim - a.sim).map(c => c.id);
      if (dense.length) {
        const scores = new Map();
        for (const list of [sparse, dense]) list.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 1 / (61 + i)));
        const ids = [...scores.keys()].sort((a, b) => scores.get(b) - scores.get(a)).slice(0, topK);
        return results(kb, ids, 'bm25+vector', scores);
      }
    }
  }
  return results(kb, sparse.slice(0, topK), 'bm25');
}

const hasKB = (courseId = 'python-intro') => loadKB(courseId) !== null;
const invalidate = courseId => cache.delete(courseId);
module.exports = { search, searchHybrid, loadKB, isBuilt: hasKB, hasKB, invalidate, tokenize };
