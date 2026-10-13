/**
 * mcp/config.js — MCP Server 配置层
 * ------------------------------------------------------------
 * 单一真相源：项目根 `mcp.servers.json`（可入库，密钥不落盘）。
 *
 * 设计要点（对齐《MCP接入方案-调研与实施路径.md》与 DeepTutor 的做法）：
 *  1) **deny-by-default**：Server 必须 `enabled: true` 且 `agents` 列出角色，
 *     该角色才看得到它的工具（DeepTutor 对非管理员同样默认拒绝）；
 *  2) **密钥只引用不落地**：env 值支持 `${VAR}` → 从 .env / 系统环境变量取值；
 *  3) **路径与运行时归一**：args 里的脚本路径按项目根解析（与启动目录无关），
 *     `command: "node"` 归一为当前进程的 node（避免多版本 Node 环境串味）；
 *  4) 配置热加载：文件 mtime 变化即重读（改配置无需重启，凭据变更可重连）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'mcp.servers.json');

const DEFAULTS = {
  startTimeoutMs: 20000, // 单 Server 启动 + 握手超时
  timeoutMs: 15000,      // 单次 tools/call 超时
  callsPerTurn: 2,       // 每轮对话内同名工具最大调用次数（与内置查询类工具一致）
  maxResultChars: 8000,  // 单次结果文本上限（防长正文灌爆上下文）
};

let cache = null;   // { servers, defaults, error, exists }
let cacheMtime = 0;

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** `${VAR}` → process.env 取值（未设置时留空串，由连接层判空并报错） */
function resolveRefs(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => process.env[key] || '');
}

/** args 里的脚本路径按项目根解析（`-y` / `pkg@1.2.3` 之类原样保留） */
function resolveArg(arg) {
  const s = String(arg);
  if (s.startsWith('-')) return s;
  if (/^([.~]|[A-Za-z]:)?[\\/]/.test(s) || /\.(js|mjs|cjs)$/i.test(s)) {
    return path.resolve(ROOT, s);
  }
  return s;
}

function normalize(name, raw, defaults) {
  const tools = raw.tools && typeof raw.tools === 'object' ? raw.tools : null;
  return {
    name,
    label: raw.label || name,
    description: raw.description || '',
    enabled: raw.enabled === true, // 默认关闭
    transport: raw.transport || 'stdio',
    command: !raw.command || raw.command === 'node' ? process.execPath : String(raw.command),
    args: (raw.args || []).map(resolveArg),
    env: Object.fromEntries(
      Object.entries(raw.env || {}).map(([k, v]) => [k, resolveRefs(v)])
    ),
    cwd: raw.cwd ? path.resolve(ROOT, raw.cwd) : ROOT,
    agents: Array.isArray(raw.agents) ? raw.agents : [], // 允许使用的角色（'*' = 全部）
    tools, // null = 全部工具；对象 = 白名单 + 单工具覆盖 { enabled, callsPerTurn }
    limits: {
      startTimeoutMs: num(raw.startTimeoutMs, defaults.startTimeoutMs),
      timeoutMs: num(raw.timeoutMs, defaults.timeoutMs),
      callsPerTurn: num(raw.callsPerTurn, defaults.callsPerTurn),
    },
    maxResultChars: num(raw.maxResultChars, defaults.maxResultChars),
  };
}

/**
 * 读取配置（mtime 变化即重读；解析失败保留上一次可用配置，不阻断主流程）。
 * @param {object} [opts] { force: 强制重读 }
 */
function load(opts = {}) {
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch (_) {
    if (!cache) cache = { servers: {}, defaults: DEFAULTS, exists: false, error: null };
    return cache;
  }
  if (!opts.force && cache && mtime === cacheMtime) return cache;

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const defaults = { ...DEFAULTS, ...(raw.defaults || {}) };
    const servers = {};
    for (const [name, s] of Object.entries(raw.servers || {})) {
      servers[name] = normalize(name, s || {}, defaults);
    }
    cache = { servers, defaults, exists: true, error: null };
    cacheMtime = mtime;
  } catch (e) {
    if (!cache) cache = { servers: {}, defaults: DEFAULTS, exists: true, error: null };
    cache.error = `mcp.servers.json 解析失败：${e.message}`;
  }
  return cache;
}

/** 某角色可用的 Server 列表（enabled + agents 命中） */
function serversForAgent(agentId) {
  const conf = load();
  return Object.values(conf.servers).filter(
    (s) => s.enabled && (s.agents.includes('*') || s.agents.includes(agentId))
  );
}

/** 单工具是否启用（tools 未配置 = 全部启用；配置了则按白名单） */
function toolEnabled(server, toolName) {
  if (!server.tools) return true;
  const t = server.tools[toolName];
  return !!(t && t.enabled !== false);
}

/** 单工具的本轮调用预算 */
function budgetOf(server, toolName) {
  const t = server.tools && server.tools[toolName];
  return num(t && t.callsPerTurn, server.limits.callsPerTurn);
}

module.exports = { CONFIG_FILE, ROOT, DEFAULTS, load, serversForAgent, toolEnabled, budgetOf };
