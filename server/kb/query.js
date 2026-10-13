/**
 * kb/query.js — 查询改写 + HyDE（假设性文档嵌入）
 * ------------------------------------------------------------
 * 学生提问往往很短、很口语（"那个循环咋写"），直接拿去检索召回率低。这里在检索前
 * 做查询扩展（对标 HyDE / multi-query 的轻量实现）：
 *
 *   ① 改写：把口语问句改写成 1~2 个更"像教材措辞"的检索式；
 *   ② HyDE：让 LLM 先写一段**假想的教材式答案**，用它的向量去检索（"答案像什么"比
 *      "问题像什么"更接近文档用语）；
 *   ③ 多查询融合：原句 + 改写式 + HyDE 文本各检索一遍，用 RRF 合并（与检索层同一套 k=60）。
 *
 * 成本控制：默认开启；`KB_QUERY_REWRITE=off` 可关；LLM 失败立即回退为"只用原句"，
 * 绝不影响主流程。纯函数 + 一次 LLM 调用，便于单测（可注入 llm）。
 */

// 延迟加载 llm：避免 tools → kb/query → agent/llm → agents → tools 的循环依赖
// （在模块加载期 require 会让 agents.js 读到未完成的 tools 导出）
function getLlm() { return require('../agent/llm'); }

const ENABLED = process.env.KB_QUERY_REWRITE !== 'off';
const MAX_VARIANTS = 3; // 原句 + 最多 2 条改写
const MIN_LEN = 2;

/** RRF 融合多路排名（与 kb/search.js 同口径 k=60） */
function rrfMergeMulti(rankLists, topK) {
  const k = 60;
  const scores = new Map();
  for (const rank of rankLists) {
    rank.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([id]) => id);
}

/**
 * 把一次检索结果按多个查询做 RRF 融合。
 * @param {Array<Array<{chunkId}>>} resultLists 每个查询命中的 chunk 列表（按 rank 有序）
 * @param {object} byId chunkId → chunk 映射
 * @param {number} topK
 */
function fuseByChunk(resultLists, byId, topK) {
  const lists = resultLists
    .filter((r) => Array.isArray(r) && r.length)
    .map((r) => r.map((c) => c.chunkId));
  if (!lists.length) return [];
  if (lists.length === 1) return resultLists[0].slice(0, topK);
  return rrfMergeMulti(lists, topK)
    .map((id) => byId.get(id))
    .filter(Boolean);
}

/**
 * 生成检索用的查询变体（含 HyDE 假设文档）。
 * @param {string} query 学生原问题
 * @param {object} [opts] { llm: 可注入便于测试, enabled: 覆盖开关 }
 * @returns {Promise<{origin:string, rewrites:string[], hyde:string|null, queries:string[]}>}
 */
async function expandQuery(query, opts = {}) {
  const origin = String(query || '').trim().slice(0, 200);
  const out = { origin, rewrites: [], hyde: null, queries: origin ? [origin] : [] };
  const enabled = opts.enabled != null ? opts.enabled : ENABLED;
  const client = opts.llm || getLlm();
  if (!enabled || origin.length < MIN_LEN) return out;
  if (typeof client.callApi !== 'function') return out;

  try {
    const text = await client.callApi([{
      role: 'user',
      content: [
        '你是检索助手。学生问了一个问题，请帮助在教材中检索到正确内容。',
        `学生问题：「${origin}」`,
        '',
        '只输出 JSON（不要其他文字）：',
        '{"rewrites":["更贴近教材措辞的检索式1","检索式2"],"hyde":"用教材口吻写的两三句假想答案"}',
        '要求：rewrites 最多 2 条，补全术语与同义词；hyde 用陈述句解释该概念，不要写"我不知道"。',
      ].join('\n'),
    }]);
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return out;
    const obj = JSON.parse(m[0]);
    const rewrites = Array.isArray(obj.rewrites)
      ? obj.rewrites.map((s) => String(s || '').trim().slice(0, 120)).filter((s) => s && s !== origin).slice(0, MAX_VARIANTS - 1)
      : [];
    const hyde = obj.hyde ? String(obj.hyde).trim().slice(0, 300) : null;
    out.rewrites = rewrites;
    out.hyde = hyde;
    out.queries = [...new Set([origin, ...rewrites])].slice(0, MAX_VARIANTS);
  } catch (e) {
    // 改写失败：静默回退原句（不打印为错误，避免噪音）
  }
  return out;
}

module.exports = { expandQuery, fuseByChunk, rrfMergeMulti, ENABLED, MAX_VARIANTS };
