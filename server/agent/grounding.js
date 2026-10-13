/**
 * agent/grounding.js — 答案忠实度校验（RAG 可溯性）
 * ------------------------------------------------------------
 * 问题：模型可能"引用着教材的名义，讲着教材里没有的内容"（幻觉）。RAG 只保证"检索到了
 * 材料"，不保证"回答被材料支撑"。本模块做**轻量忠实度校验**：
 *
 *   在生成回答后，用一次 LLM 判定回答中的关键论断是否被检索片段支撑，输出
 *   supported / partially / unsupported 与不支撑的论断列表。
 *
 * 定位：**只标注与留痕，不阻断、不改写回答**（避免误伤、避免增加用户等待的不可控步骤）。
 * 结果写入 turn.grounding 与运行日志，供报告/后台核查；`GROUNDING_CHECK=off` 可关。
 * 失败静默返回 null，绝不影响主流程。
 */

const llm = require('./llm');

const ENABLED = process.env.GROUNDING_CHECK !== 'off';
const MAX_SOURCES = 4;
const MIN_REPLY = 40; // 回答太短不校验（成本无谓）
const TIMEOUT_MS = Number(process.env.GROUNDING_TIMEOUT_MS) || 8000; // 防止悬挂的 LLM 调用泄漏 pending

/**
 * 判定回答是否被来源片段支撑。
 * @param {string} reply 模型最终回答
 * @param {Array<{content?:string, source?:string}>} sources 检索片段（教材/联网）
 * @param {object} [opts] { llm, enabled }
 * @returns {Promise<{verdict:'supported'|'partially'|'unsupported', unsupported:string[], ratio:number}|null>}
 */
async function checkGrounding(reply, sources, opts = {}) {
  const enabled = opts.enabled != null ? opts.enabled : ENABLED;
  const client = opts.llm || llm;
  const answer = String(reply || '').trim();
  const srcs = (Array.isArray(sources) ? sources : [])
    .filter((s) => s && (s.content || s.text))
    .slice(0, MAX_SOURCES);
  if (!enabled || answer.length < MIN_REPLY || !srcs.length) return null;
  if (typeof client.callApi !== 'function') return null;

  const ctx = srcs
    .map((s, i) => `[片段${i + 1}${s.source ? ` · ${s.source}` : ''}] ${String(s.content || s.text).slice(0, 600)}`)
    .join('\n\n');

  try {
    const call = client.callApi([{
      role: 'user',
      content: [
        '你是事实核查员。判断"老师回答"中的关键论断是否被下方"资料片段"支撑。',
        '',
        `老师的回答：\n${answer.slice(0, 1200)}`,
        '',
        `资料片段：\n${ctx}`,
        '',
        '只输出 JSON（不要其他文字）：',
        '{"verdict":"supported|partially|unsupported","unsupported":["不被资料支撑的论断，最多3条"]}',
        '判定：全部关键论断都有资料依据→supported；部分有→partially；基本无依据（靠自身知识发挥）→unsupported。',
      ].join('\n'),
    }]);
    // 内部超时：本模块是异步旁路，悬挂调用不得长期占用连接
    const text = await Promise.race([
      call,
      new Promise((_, reject) => setTimeout(() => reject(new Error('grounding timeout')), TIMEOUT_MS)),
    ]);
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    const verdict = ['supported', 'partially', 'unsupported'].includes(obj.verdict) ? obj.verdict : 'partially';
    const unsupported = Array.isArray(obj.unsupported)
      ? obj.unsupported.map((s) => String(s || '').trim().slice(0, 100)).filter(Boolean).slice(0, 3)
      : [];
    const ratio = verdict === 'supported' ? 1 : verdict === 'partially' ? 0.6 : 0.2;
    return { verdict, unsupported, ratio, checkedAt: new Date().toISOString() };
  } catch (e) {
    return null; // 校验失败静默
  }
}

/** 从工具调用轨迹里抽出可用的来源片段（教材检索 + 联网检索） */
function sourcesFromToolCalls(toolCalls) {
  const out = [];
  for (const t of toolCalls || []) {
    const o = t && t.output;
    if (!o || !Array.isArray(o.results)) continue;
    for (const r of o.results) {
      const content = r.content || r.snippet || r.text;
      if (!content) continue;
      out.push({ content: String(content), source: r.source || r.title || r.name || t.name });
    }
  }
  return out;
}

module.exports = { checkGrounding, sourcesFromToolCalls, ENABLED };
