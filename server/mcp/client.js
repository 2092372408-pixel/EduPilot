/**
 * mcp/client.js — MCP 连接层（stdio 传输）
 * ------------------------------------------------------------
 * 职责单一：把 mcp.servers.json 里 **enabled** 的 Server 拉起来、连上、
 * 缓存工具目录、代理 tools/call。不管工具怎么给模型用（那是 bridge 的事）。
 *
 * 关键实现约定：
 *  1) 子进程只拿到「声明的环境变量 + SDK 安全默认集」，不整体继承 process.env
 *     （密钥外泄面最小化，对应方案文档 §7）；
 *  2) stdio 下 stdout 是协议通道 —— Server 的日志只能走 stderr，这里转发到 runtime 日志；
 *  3) 每个 Server 独立失败：起不来只记日志并标记 failed，不影响其他 Server 与主流程；
 *  4) 懒重连：failed 的 Server 在下次被调用时（间隔 > 30s）自动重试一次，
 *     配置 mtime 变化（含凭据变更）也会触发重连 —— 借鉴 DeepTutor 的做法。
 */

require('../env'); // 先加载 .env，保证 ${ENV} 引用能取到值

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const config = require('./config');
const logger = require('../store/logger');

const CLIENT_INFO = { name: 'eduowl-agent', version: '1.0.0' };
const RETRY_COOLDOWN_MS = 30000; // failed → 重试冷却

/** Promise 超时包装（SDK 只对单次请求超时，不覆盖"进程起不来"的场景） */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

class Conn {
  constructor(cfg) {
    this.cfg = cfg;
    this.status = 'idle'; // idle | connecting | ready | failed | closed
    this.error = null;
    this.tools = [];   // 原始 MCP 工具定义（已按配置过滤）
    this.client = null;
    this.transport = null;
    this.pid = null;
    this.calls = 0;
    this.errors = 0;
    this.lastCallAt = null;
    this.lastAttemptAt = 0;
    this.readyAt = null;
    this.stderrTail = []; // 子进程 stderr 摘要（诊断用，最多留 3 行）
  }
}

/** 按配置过滤该 Server 暴露的工具（tools 未配置 = 全部启用） */
function filterTools(server, tools) {
  return (tools || []).filter((t) => t && t.name && config.toolEnabled(server, t.name));
}

async function connect(conn) {
  const cfg = conn.cfg;
  conn.status = 'connecting';
  conn.error = null;
  conn.lastAttemptAt = Date.now();

  const env = { ...getDefaultEnvironment(), ...cfg.env };
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env,
    cwd: cfg.cwd,
    stderr: 'pipe',
  });
  const errStream = transport.stderr;
  if (errStream && typeof errStream.on === 'function') {
    errStream.on('data', (chunk) => {
      const text = String(chunk).replace(/\s+$/, '');
      if (!text) return;
      conn.stderrTail.push(text.slice(0, 200));
      if (conn.stderrTail.length > 3) conn.stderrTail.shift();
      logger.warn('mcp_stderr', `[${cfg.name}] ${text.slice(0, 300)}`);
    });
  }

  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await withTimeout(
      client.connect(transport),
      cfg.limits.startTimeoutMs,
      `启动超时（>${Math.round(cfg.limits.startTimeoutMs / 1000)}s）`
    );
    const list = await client.listTools({}, { timeout: cfg.limits.timeoutMs });
    conn.client = client;
    conn.transport = transport;
    conn.pid = typeof transport.pid === 'number' ? transport.pid : null;
    conn.tools = filterTools(cfg, list && list.tools);
    conn.status = 'ready';
    conn.readyAt = Date.now();
    logger.info(
      'mcp_connect',
      `[${cfg.name}] 已连接（pid=${conn.pid}）：${conn.tools.length} 个工具 → ${conn.tools.map((t) => t.name).join(', ') || '无'}`
    );
  } catch (e) {
    conn.status = 'failed';
    conn.error = e.message;
    try { await client.close(); } catch (_) { /* 忽略：连接失败时的清理异常 */ }
    try { await transport.close(); } catch (_) { /* 忽略 */ }
    throw e;
  }
  return conn;
}

class McpManager {
  constructor() {
    this.conns = new Map(); // name → Conn
    this.startedAt = null;
    this.lastResults = [];
  }

  /**
   * 启动/重载所有 enabled 的 Server（并发；单个失败不抛）。
   * @returns {Promise<Array<{name, ok, tools?, error?, reused?}>>}
   */
  async start(opts = {}) {
    const conf = config.load({ force: opts.force });
    if (conf.error) logger.warn('mcp_config', conf.error);

    const wanted = Object.values(conf.servers).filter((s) => s.enabled);

    // 配置里已删除/禁用的 Server：关闭旧连接
    for (const name of [...this.conns.keys()]) {
      if (!wanted.some((s) => s.name === name)) {
        logger.info('mcp_disable', `[${name}] 已从配置禁用/移除，关闭连接`);
        await this.close(name);
      }
    }

    const results = await Promise.all(
      wanted.map(async (cfg) => {
        const existing = this.conns.get(cfg.name);
        const unchanged = existing && JSON.stringify(existing.cfg) === JSON.stringify(cfg);
        if (existing && unchanged && existing.status === 'ready' && !opts.force) {
          return { name: cfg.name, ok: true, tools: existing.tools.length, reused: true };
        }
        if (existing) await this.close(cfg.name);
        const conn = new Conn(cfg);
        this.conns.set(cfg.name, conn);
        try {
          await connect(conn);
          return { name: cfg.name, ok: true, tools: conn.tools.length };
        } catch (e) {
          conn.status = 'failed';
          logger.warn('mcp_connect_failed', `[${cfg.name}] 连接失败：${e.message}`);
          return { name: cfg.name, ok: false, error: e.message };
        }
      })
    );

    this.startedAt = new Date().toISOString();
    this.lastResults = results;
    const ok = results.filter((r) => r.ok).length;
    if (wanted.length) {
      logger.info('mcp_start', `MCP 启动完成：${ok}/${wanted.length} 个 Server 就绪`);
    }
    return results;
  }

  /** 懒重连：failed 的 Server 在冷却期过后被调用时重试一次 */
  async ensure(name) {
    const conn = this.conns.get(name);
    if (!conn) return null;
    if (conn.status === 'ready') return conn;
    if (conn.status === 'connecting') return null;
    if (conn.status === 'failed' && Date.now() - conn.lastAttemptAt < RETRY_COOLDOWN_MS) return null;
    try {
      await connect(conn);
      return conn;
    } catch (e) {
      conn.status = 'failed';
      conn.error = e.message;
      logger.warn('mcp_reconnect_failed', `[${name}] 重连失败：${e.message}`);
      return null;
    }
  }

  /** 已就绪的 Server 连接列表 */
  readyConns() {
    return [...this.conns.values()].filter((c) => c.status === 'ready');
  }

  /** 工具目录：[{ server, def }]（仅就绪 Server） */
  toolDefs() {
    const out = [];
    for (const conn of this.readyConns()) {
      for (const def of conn.tools) out.push({ server: conn.cfg.name, def });
    }
    return out;
  }

  /** 调用 MCP 工具（带超时；失败返回 {ok:false, error}，不抛） */
  async call(serverName, toolName, args = {}) {
    const conn = await this.ensure(serverName);
    if (!conn) {
      const c = this.conns.get(serverName);
      const why = c ? (c.error || c.status) : '未在 mcp.servers.json 中启用';
      return { ok: false, error: `MCP Server「${serverName}」不可用（${why}）` };
    }
    const t0 = Date.now();
    try {
      const res = await conn.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: conn.cfg.limits.timeoutMs }
      );
      conn.calls += 1;
      conn.lastCallAt = new Date().toISOString();
      const ms = Date.now() - t0;
      logger.info('mcp_call', `[${serverName}.${toolName}] ${ms}ms ${res && res.isError ? 'isError' : 'ok'}`);
      return { ok: true, result: res, ms };
    } catch (e) {
      conn.errors += 1;
      const ms = Date.now() - t0;
      logger.warn('mcp_call_failed', `[${serverName}.${toolName}] ${ms}ms ${e.message}`);
      return { ok: false, error: `MCP 调用失败：${e.message}`, ms };
    }
  }

  /** 运行状态（后台页 / 诊断用） */
  status() {
    return [...this.conns.values()].map((c) => ({
      name: c.cfg.name,
      label: c.cfg.label,
      transport: c.cfg.transport,
      status: c.status,
      error: c.error,
      pid: c.pid,
      agents: c.cfg.agents,
      tools: c.tools.map((t) => ({ name: t.name, description: (t.description || '').slice(0, 80) })),
      calls: c.calls,
      errors: c.errors,
      lastCallAt: c.lastCallAt,
      limits: c.cfg.limits,
      stderrTail: c.stderrTail,
    }));
  }

  summary() {
    const list = this.status();
    return {
      enabled: list.length,
      ready: list.filter((s) => s.status === 'ready').length,
      tools: list.reduce((n, s) => n + (s.status === 'ready' ? s.tools.length : 0), 0),
      calls: list.reduce((n, s) => n + s.calls, 0),
      errors: list.reduce((n, s) => n + s.errors, 0),
      startedAt: this.startedAt,
    };
  }

  async close(name) {
    const conn = this.conns.get(name);
    if (!conn) return;
    conn.status = 'closed';
    try { if (conn.client) await conn.client.close(); } catch (_) { /* 忽略 */ }
    try { if (conn.transport) await conn.transport.close(); } catch (_) { /* 忽略 */ }
    this.conns.delete(name);
  }

  /** 关闭全部连接（进程退出/重启时调用） */
  async stop() {
    await Promise.all([...this.conns.keys()].map((n) => this.close(n)));
  }
}

const manager = new McpManager();

// 进程退出时收敛子进程（避免 stdio Server 变孤儿进程）
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    manager.stop().finally(() => process.exit(0));
  });
}

module.exports = manager;
module.exports.McpManager = McpManager;
module.exports.CLIENT_INFO = CLIENT_INFO;
