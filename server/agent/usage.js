/**
 * agent/usage.js — 会话级 token / 成本核算与预算
 * ------------------------------------------------------------
 * 动机：接的是付费 OpenAI 兼容 API（Qwen 等），但此前只记录耗时，没有 token 数与成本，
 * 上线后无法发现"某个会话把额度烧光"（runaway RAG/工具循环）。
 *
 * 做法：
 *   · llm.js 在每次请求后把上游返回的 usage 交给本模块累计（无 usage 时按字符粗估）；
 *   · 按模型单价表估算费用（可通过环境变量覆盖；未知单价返回 null，不冒充免费）；
 *   · 会话累计超预算时给出提示（warn 日志 + 后台可见），**不硬中断**（避免打断教学）。
 *
 * 纯计算 + 内存累计；单价表可用 TOKEN_PRICES_JSON 覆盖。
 */

const { AsyncLocalStorage } = require('async_hooks');
const logger = require('../store/logger');

/**
 * 会话上下文（AsyncLocalStorage）：让深层调用（llm → usage.record）无需层层透传 sessionId
 * 也能把用量归到正确会话。相比"全局变量"，它在并发会话之间是隔离的。
 */
const als = new AsyncLocalStorage();

/** 在指定会话上下文中执行 fn（core 每轮调用包裹整轮逻辑） */
function runWithSession(sessionId, fn) {
  return als.run({ sessionId: String(sessionId || 'default') }, fn);
}

/** 当前上下文中的会话 id（无则 'default'） */
function currentSession() {
  const store = als.getStore();
  return (store && store.sessionId) || 'default';
}

// 单价表：每 100 万 token 的美元价。人民币报价须先换算，不能混用币种。
const DEFAULT_PRICES = {
  'qwen-plus': { in: 0.4, out: 1.2 },
  'deepseek-chat': { in: 0.27, out: 1.1 },
};

function prices() {
  if (process.env.TOKEN_PRICES_JSON) {
    try { return { ...DEFAULT_PRICES, ...JSON.parse(process.env.TOKEN_PRICES_JSON) }; } catch (_) { /* 用默认 */ }
  }
  return DEFAULT_PRICES;
}

/** 单会话预算（token）：超过只提示不阻断；0/未设 = 不限制 */
const DEFAULT_BUDGET = Number(process.env.TOKEN_BUDGET_PER_SESSION) || 0;

/** 粗估 token（无 usage 时的兜底）：中文约 1 字≈1 token，英文约 4 字符≈1 token */
function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) if (/[\u4e00-\u9fa5]/.test(ch)) cjk++;
  const others = s.length - cjk;
  return Math.ceil(cjk + others / 4);
}

/** 会话用量内存累计表：sessionId → { prompt, completion, calls, cost, warned } */
const _usage = new Map();

function bucket(sessionId) {
  const key = String(sessionId || 'default');
  if (!_usage.has(key)) _usage.set(key, { prompt: 0, completion: 0, calls: 0, cost: 0, unknownPriceCalls: 0, estimatedCalls: 0, budgetWarned: false });
  return _usage.get(key);
}

/** 计算一次调用的费用（美元） */
function costOf(model, promptTokens, completionTokens) {
  const p = prices()[model] || prices()[String(model || '').replace(/^.*\//, '')] || null;
  if (!p || !Number.isFinite(p.in) || !Number.isFinite(p.out) || p.in < 0 || p.out < 0) return null;
  return (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out;
}

/**
 * 记录一次 LLM 调用的用量。
 * @param {string} sessionId
 * @param {{usage?:{prompt_tokens:number,completion_tokens:number}, promptText?:string, completionText?:string}} info
 * @returns {{prompt:number, completion:number, total:number, cost:number, overBudget:boolean}}
 */
function record(sessionId, info = {}) {
  const u = bucket(sessionId);
  const model = process.env.LLM_MODEL || 'deepseek-chat';
  let promptTok = 0;
  let completionTok = 0;
  if (info.usage && Number.isFinite(info.usage.prompt_tokens)) {
    promptTok = info.usage.prompt_tokens;
    completionTok = info.usage.completion_tokens || 0;
  } else {
    u.estimatedCalls += 1;
    promptTok = estimateTokens(info.promptText);
    completionTok = estimateTokens(info.completionText);
  }
  const cost = costOf(model, promptTok, completionTok);
  u.prompt += promptTok;
  u.completion += completionTok;
  u.calls += 1;
  if (cost === null) u.unknownPriceCalls += 1;
  else u.cost += cost;

  const total = u.prompt + u.completion;
  const overBudget = DEFAULT_BUDGET > 0 && total > DEFAULT_BUDGET;
  if (overBudget && !u.budgetWarned) {
    u.budgetWarned = true;
    try {
      logger.warn('token_budget', `[${sessionId}] 会话 token 用量 ${total} 已超过预算 ${DEFAULT_BUDGET}（调用 ${u.calls} 次，${u.unknownPriceCalls ? '费用未知：单价未配置' : '估算花费 $' + u.cost.toFixed(4)}）`);
    } catch (_) { /* 日志失败不影响主流程 */ }
  }
  return { prompt: promptTok, completion: completionTok, total, cost, overBudget };
}

/** 取某会话累计用量 */
function get(sessionId) {
  const u = _usage.get(String(sessionId || 'default'));
  if (!u) return { prompt: 0, completion: 0, total: 0, calls: 0, cost: 0, currency: 'USD', unknownPriceCalls: 0, estimatedCalls: 0, budget: DEFAULT_BUDGET };
  return { prompt: u.prompt, completion: u.completion, total: u.prompt + u.completion, calls: u.calls, cost: u.unknownPriceCalls ? null : Number(u.cost.toFixed(6)), currency: 'USD', unknownPriceCalls: u.unknownPriceCalls, estimatedCalls: u.estimatedCalls, budget: DEFAULT_BUDGET, overBudget: DEFAULT_BUDGET > 0 && (u.prompt + u.completion) > DEFAULT_BUDGET };
}

/** 清理某会话用量（重置会话时） */
function clear(sessionId) { _usage.delete(String(sessionId || 'default')); }

/** 全局汇总（后台/健康检查用） */
function summary() {
  let prompt = 0, completion = 0, calls = 0, cost = 0, unknownPriceCalls = 0, estimatedCalls = 0;
  for (const u of _usage.values()) { prompt += u.prompt; completion += u.completion; calls += u.calls; cost += u.cost; unknownPriceCalls += u.unknownPriceCalls; estimatedCalls += u.estimatedCalls; }
  return { sessions: _usage.size, prompt, completion, total: prompt + completion, calls, cost: unknownPriceCalls ? null : Number(cost.toFixed(6)), currency: 'USD', unknownPriceCalls, estimatedCalls, budgetPerSession: DEFAULT_BUDGET };
}

module.exports = { record, get, clear, summary, estimateTokens, costOf, runWithSession, currentSession, DEFAULT_BUDGET };
