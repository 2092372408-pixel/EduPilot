#!/usr/bin/env node
/**
 * mcp/servers/webtools.js — 自建 MCP Server（stdio）：网页读取
 * ------------------------------------------------------------
 * 为什么自建：① 官方 fetch MCP 是 Python 系（本机无 uv，装不了）；
 *            ② 自己实现才能把**域白名单 + 内网 IP 黑名单**这类安全约束钉死在服务端，
 *               而不是指望模型自觉（方案文档 §7 的第一条风险就是 SSRF）。
 *
 * 暴露工具：
 *   server_info  健康探测（服务名/版本/pid/时间/安全开关）——零外网依赖，供冒烟测试
 *   fetch_page   读取网页并转纯文本（HTML→可读文本，保留标题与段落）
 *
 * 安全约束（默认开启，可用 MCP_WEBTOOLS_ALLOW_PRIVATE=1 关闭 —— 仅本地测试用）：
 *   · 协议仅 http / https
 *   · 域名解析后的 IP 落在内网/保留网段 → 直接拒绝（10./172.16-31./192.168./127./169.254./::1/fc00::/7…）
 *   · 重定向逐跳校验（最多 3 跳），避免"公网域名 302 到内网"绕过
 *   · 响应体大小上限 + 单次请求超时
 *
 * 注意：stdio 传输下 **stdout 是协议通道**，本进程任何日志只能走 stderr。
 */

const dns = require('dns').promises;
const net = require('net');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const NAME = 'eduowl-webtools';
const VERSION = '1.0.0';
const ALLOW_PRIVATE = process.env.MCP_WEBTOOLS_ALLOW_PRIVATE === '1';
const MAX_BYTES = 2 * 1024 * 1024;   // 响应体硬上限
const DEFAULT_CHARS = 4000;          // 正文默认返回长度
const FETCH_TIMEOUT_MS = 12000;
const MAX_HOPS = 3;
const UA = 'EduPilotBot/1.0 (+local teaching agent; contact: local)';

/* ---------------------------------- SSRF 防护 ---------------------------------- */

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4ToInt = (ip) => ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
const inCidr = (ipInt, base, bits) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (v4ToInt(base) & mask);
};

/**
 * IPv6 → 16 字节。必须把 **IPv4 映射地址**（::ffff:a.b.c.d）解出来按 IPv4 规则复核：
 * Node 的 URL 解析会把 `::ffff:127.0.0.1` **规范化成 `::ffff:7f00:1`**，
 * 因此只匹配点分十进制字面量的旧写法会被绕过（实测 127.0.0.1 / 169.254.169.254 的
 * 映射形式均未拦截）。这里统一在字节层面识别，覆盖 `::ffff:0:0/96` 与
 * `::ffff:0:0:0/96` 两类映射前缀。
 */
function ipv6ToBytes(ip) {
  let s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  // 组里可能内嵌点分十进制 IPv4（如 ::ffff:127.0.0.1）→ 先转成两个十六进制组
  const dotted = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const p = dotted[1].split('.').map(Number);
    if (p.some((n) => !Number.isFinite(n) || n > 255)) return null;
    const hex = ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
    s = s.slice(0, dotted.index) + hex;
  }
  // 展开 "::"
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const hp = head ? head.split(':').filter((x) => x !== '') : [];
  const tp = tail !== null && tail !== undefined ? (tail ? tail.split(':').filter((x) => x !== '') : []) : [];
  const fill = 8 - hp.length - tp.length;
  if (fill < 0) return null;
  const groups = [...hp, ...Array(fill).fill('0'), ...tp];
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function isBlockedIp(ip) {
  const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(s)) {
    const n = v4ToInt(s);
    return BLOCKED_V4.some(([base, bits]) => inCidr(n, base, bits));
  }
  if (net.isIPv6(s)) {
    if (s === '::1' || s === '::') return true;
    if (/^f[cd]/.test(s)) return true;                 // fc00::/7 唯一本地地址
    if (/^fe[89ab]/.test(s)) return true;              // fe80::/10 链路本地
    if (/^ff/.test(s)) return true;                    // ff00::/8 组播
    // IPv4 映射/兼容地址：从字节提取内嵌 IPv4，按 IPv4 规则复核（覆盖十六进制写法）
    const b = ipv6ToBytes(s);
    if (b) {
      const zeroPrefix = b.slice(0, 10).every((x) => x === 0);
      const mapped = zeroPrefix && b[10] === 0xff && b[11] === 0xff;      // ::ffff:a.b.c.d
      const compat = b.slice(0, 12).every((x) => x === 0);               // ::a.b.c.d
      if (mapped || compat) {
        const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
        return isBlockedIp(v4);
      }
    }
    return false;
  }
  return true; // 非法 IP 一律当作不安全
}

/** 校验 URL：协议 + 解析后 IP 双重检查（跳过 = allowPrivate 模式） */
async function assertUrlSafe(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch (_) {
    throw new Error(`不是合法的网址：${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅支持 http/https 网页，收到：${url.protocol}`);
  }
  if (ALLOW_PRIVATE) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error(`域名解析失败：${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new Error(`目标地址属于内网/保留网段（${host} → ${a.address}），已拒绝访问`);
    }
  }
  return url;
}

/* --------------------------------- HTML → 文本 --------------------------------- */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', times: '×',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', deg: '°', euro: '€', yen: '¥',
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] !== undefined ? ENTITIES[n.toLowerCase()] : m));
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/** 轻量正文提取：去脚本样式 → 块级标签转换行 → 去标签 → 收敛空白 */
function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|template|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])[^>]*>/gi, (_, lv) => `\n${'#'.repeat(Number(lv))} `)
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|ul|ol|blockquote|pre|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ----------------------------------- 抓取 ----------------------------------- */

/** 手动跟随重定向（逐跳做 SSRF 校验），并限制响应体大小 */
async function fetchPage(rawUrl) {
  let url = await assertUrlSafe(rawUrl);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return { res, url, body: '' };
      if (hop === MAX_HOPS) throw new Error(`重定向次数超过 ${MAX_HOPS} 次`);
      url = await assertUrlSafe(new URL(loc, url).href);
      continue;
    }
    // 限额读取
    const chunks = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { try { await reader.cancel(); } catch (_) { /* 忽略 */ } break; }
        chunks.push(Buffer.from(value));
      }
    }
    return { res, url, body: Buffer.concat(chunks).toString('utf8'), truncatedBody: size > MAX_BYTES, bytes: size };
  }
  throw new Error('重定向处理异常');
}

/* ----------------------------------- 启动 ----------------------------------- */

const server = new McpServer({ name: NAME, version: VERSION });

server.registerTool(
  'server_info',
  {
    title: '服务自检',
    description: '返回本 MCP 服务的名称、版本、pid、当前时间与安全开关状态。用于连通性/健康检查，不访问外网。',
    inputSchema: {},
  },
  async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        server: NAME,
        version: VERSION,
        pid: process.pid,
        node: process.version,
        time: new Date().toISOString(),
        allowPrivate: ALLOW_PRIVATE,
        limits: { maxBytes: MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS, maxHops: MAX_HOPS },
      }),
    }],
  })
);

server.registerTool(
  'fetch_page',
  {
    title: '读取网页正文',
    description:
      '读取指定网页，返回标题与正文纯文本（HTML→文本）。适合需要"读一篇文档/新闻/教程原文"的场景（例如读官方文档某一页、看某篇最新文章）。'
      + '仅支持公开的 http/https 网页；内网与保留地址会被拒绝。只取正文，不做交互（点击/填表）。'
      + '如果只是想快速拿"最新信息摘要"，用联网检索工具（tavily_search / search_dev）更省时。',
    inputSchema: {
      url: z.string().describe('要读取的网页地址，必须以 http:// 或 https:// 开头'),
      maxChars: z.number().int().min(200).max(20000).optional().describe('正文最多返回多少字符，默认 4000'),
    },
  },
  async ({ url, maxChars }) => {
    const limit = maxChars || DEFAULT_CHARS;
    try {
      const { res, url: finalUrl, body, truncatedBody, bytes } = await fetchPage(url);
      const contentType = res.headers.get('content-type') || '';
      const title = extractTitle(body);
      const text = /html|xml/i.test(contentType) || /<html|<!doctype/i.test(body.slice(0, 500))
        ? htmlToText(body)
        : body.trim();
      const payload = {
        url: String(url),
        finalUrl: finalUrl.href,
        status: res.status,
        contentType: contentType.split(';')[0],
        title,
        bytes: bytes || Buffer.byteLength(body),
        truncatedFromBody: !!truncatedBody,
        text: text.length > limit ? `${text.slice(0, limit)}\n…（正文较长，已截断，共 ${text.length} 字）` : text,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    } catch (e) {
      const msg = e && e.name === 'TimeoutError'
        ? `请求超时（>${FETCH_TIMEOUT_MS / 1000}s）`
        : (e && e.message) || String(e);
      console.error(`[${NAME}] fetch_page 失败: ${msg} | ${url}`);
      return { content: [{ type: 'text', text: `读取失败：${msg}` }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${NAME}] v${VERSION} 已就绪（pid=${process.pid}，allowPrivate=${ALLOW_PRIVATE}）`);
}

main().catch((e) => {
  console.error(`[${NAME}] 启动失败:`, e && e.stack ? e.stack : e);
  process.exit(1);
});
