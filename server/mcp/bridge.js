/**
 * mcp/bridge.js — MCP 工具 ↔ 内部工具表 的桥接层
 * ------------------------------------------------------------
 * 核心思想（对齐 DeepTutor：MCP 不是新引擎，而是"工具来源"的扩展点）：
 *   MCP 工具被翻译成与内置 9 工具**完全同构**的 `{ name, description, args,
 *   parameters, run }` 结构，注册进同一张工具表 —— 于是现有的
 *   ①角色白名单 ②每轮调用预算 ③工具轨迹审计 三套机制**自动复用**，
 *   两条引擎（legacy ReAct / LangGraph function calling）也天然都吃得到。
 *
 * 命名空间：`mcp__<server>__<tool>`（避免与内置工具重名，也便于按 Server 粒度授权）。
 * 降级：MCP 调用失败只返回 { error }，由模型改用其他工具（如 search_knowledge_base），不中断主流程。
 */

const manager = require('./client');
const config = require('./config');
const logger = require('../store/logger');

const PREFIX = 'mcp__';
const nameOf = (server, tool) => `${PREFIX}${server}__${tool}`;

/** 联网工具（受首页「是否联网」开关约束；外网读取同样需要允许） */
// All outbound web tools are hidden when a request is marked off. This
// includes page extraction, which is network access even though its name does
// not contain "search".
const SEARCH_TOOL_RE = /search|research|extract|fetch_page|crawl|map/i;
const isSearchTool = (toolName) => SEARCH_TOOL_RE.test(toolName);

/** JSON Schema → 紧凑 args 说明（legacy ReAct 提示词用，LangGraph 走 parameters 原样透传） */
function argsHint(schema) {
  const props = schema && schema.properties;
  if (!props || !Object.keys(props).length) return '{}';
  const required = new Set((schema && schema.required) || []);
  const parts = Object.entries(props).map(([key, v]) => {
    const type = (v && (v.type || (v.enum ? 'enum' : 'any'))) || 'any';
    const enumText = v && v.enum ? `，取值 ${v.enum.join('|')}` : '';
    return `"${key}": "${type}"（${required.has(key) ? '必填' : '可选'}${enumText}）`;
  });
  return `{${parts.join(', ')}}`;
}

/** 超长文本裁剪（保护上下文预算） */
function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，原文 ${s.length} 字）` : s;
}

/** MCP tools/call 结果 → 模型可读对象（纯函数，便于单测） */
function shapeResult(res, maxChars) {
  if (!res || typeof res !== 'object') return { error: 'MCP 返回空结果' };
  const texts = (res.content || [])
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text);
  const joined = texts.join('\n').trim();
  if (res.isError) return { error: clip(joined || 'MCP 工具返回错误', maxChars) };
  const hasStructured = res.structuredContent && typeof res.structuredContent === 'object';
  if (!texts.length && hasStructured) return res.structuredContent;
  if (!texts.length) return { ok: true, note: '（该工具未返回文本内容）' };
  if (texts.length === 1) {
    const only = texts[0].trim();
    if (only.startsWith('{') || only.startsWith('[')) {
      try { return JSON.parse(only); } catch (_) { /* 非 JSON，按文本返回 */ }
    }
    return { text: clip(texts[0], maxChars) };
  }
  return { text: clip(joined, maxChars) };
}

/** 把一个 MCP 工具定义翻译成内部工具结构 */
function buildTool(conn, def) {
  const server = conn.cfg.name;
  const name = nameOf(server, def.name);
  const maxChars = conn.cfg.maxResultChars;
  return {
    name,
    source: 'mcp',
    mcp: { server, tool: def.name },
    budgetPerTurn: config.budgetOf(conn.cfg, def.name),
    description: `[MCP·${conn.cfg.label}] ${def.description || def.name}`,
    args: argsHint(def.inputSchema),
    parameters: def.inputSchema && def.inputSchema.type ? def.inputSchema : { type: 'object', properties: {} },
    async run(input) {
      // 课程边界闸门（硬拦截）：检索类工具只在本轮"允许联网"时执行。
      // 提示词只是软约束，模型仍可能自作主张调用；这里做最后一道防线，
      // 由 core 每轮通过 scope.runWithWebScope 声明是否允许（AsyncLocalStorage）。
      if (isSearchTool(def.name)) {
        try {
          const scope = require('../agent/scope');
          if (!scope.isWebAllowedNow()) {
            return {
              error: '本次未获准联网检索：该问题与当前课程/编程学习无关，或学生选择了不联网',
              tool: name,
              hint: '不要重试该工具；请如实说明"这个问题和课程无关/本次不联网"，并把话题引导回本课程的学习内容',
            };
          }
        } catch (_) { /* 闸门不可用时保持既有行为 */ }
      }
      const call = await manager.call(server, def.name, input || {});
      if (!call.ok) {
        return {
          error: call.error,
          tool: name,
          hint: '这不是系统性故障：本次 MCP 调用未成功，请改用其他工具（如 search_knowledge_base）或如实告知学生',
        };
      }
      return shapeResult(call.result, maxChars);
    },
  };
}

/** 当前所有可用的 MCP 工具（已就绪 Server × 已启用工具）→ { name: toolDef } */
function allTools(opts = {}) {
  const conf = config.load();
  const out = {};
  for (const conn of manager.readyConns()) {
    const serverCfg = conf.servers[conn.cfg.name];
    if (!serverCfg || !serverCfg.enabled) continue;
    for (const def of conn.tools) {
      if (!config.toolEnabled(serverCfg, def.name)) continue;
      out[nameOf(conn.cfg.name, def.name)] = buildTool(conn, def);
    }
  }
  return out;
}

/**
 * 某角色可见的 MCP 工具（deny-by-default：Server 的 agents 里没这个角色 = 看不见）。
 * @param {string} agentId 角色 id
 * @param {object} [opts] { webMode } —— webMode==='off' 时隐藏检索类工具（学生选择本次不联网）
 */
function toolsForAgent(agentId, opts = {}) {
  const webOff = opts.webMode === 'off';
  const conf = config.load();
  const out = {};
  for (const conn of manager.readyConns()) {
    const serverCfg = conf.servers[conn.cfg.name];
    if (!serverCfg || !serverCfg.enabled) continue;
    if (!(serverCfg.agents.includes('*') || serverCfg.agents.includes(agentId))) continue;
    for (const def of conn.tools) {
      if (!config.toolEnabled(serverCfg, def.name)) continue;
      if (webOff && isSearchTool(def.name)) continue; // 不联网：检索类工具对本轮不可见
      out[nameOf(conn.cfg.name, def.name)] = buildTool(conn, def);
    }
  }
  return out;
}

/** 工具名清单（调试/审计用） */
function toolNames(agentId, opts) {
  return Object.keys(agentId ? toolsForAgent(agentId, opts) : allTools());
}

/**
 * 启动全部 MCP Server（幂等；已 ready 且配置未变则复用连接）。
 * 供 server/index.js 启动时调用：失败仅记日志，不影响 Web 服务。
 */
async function start(opts = {}) {
  const results = await manager.start(opts);
  for (const r of results) {
    logger[r.ok ? 'info' : 'warn'](
      'mcp_bridge',
      `[${r.name}] ${r.ok ? `就绪（${r.tools} 工具${r.reused ? '，复用连接' : ''}）` : `不可用：${r.error}`}`
    );
  }
  return results;
}

module.exports = {
  start,
  allTools,
  toolsForAgent,
  toolNames,
  isSearchTool,
  shapeResult, // 导出供单测
  argsHint,
  nameOf,
  PREFIX,
  status: () => manager.status(),
  summary: () => manager.summary(),
  stop: () => manager.stop(),
  manager,
};
