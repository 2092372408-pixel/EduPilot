#!/usr/bin/env node
/**
 * mcp/servers/devsites.js — 自建 MCP Server（stdio）：编程 / AI 权威站点专属接入
 * ------------------------------------------------------------
 * 与通用联网搜索的区别：这里把「**去哪些站、按什么口径查**」钉死在服务端，
 * 模型只表达"想查什么、想查哪个站"，避免它自由发挥去读不可信来源（教学场景更可控）。
 *
 * 暴露工具：
 *   list_dev_sites  站点目录（零外网依赖，供模型/自检了解可用站点，也是连通性探测）
 *   search_dev      在指定权威站点内检索（Tavily API + include_domains 限定域名）
 *   github_search   GitHub 仓库 / 代码 / issue 检索（走 GitHub 官方 REST API，独立配额）
 *
 * 凭证：TAVILY_API_KEY（复用 .env）；GITHUB_TOKEN 可选（提高 GitHub 搜索配额）。
 * 注意：stdio 传输下 **stdout 是协议通道**，本进程任何日志只能走 stderr。
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const NAME = 'eduowl-devsites';
const VERSION = '1.0.0';
const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TIMEOUT_MS = 20000;
const UA = 'EduPilotBot/1.0 (+local teaching agent)';

/**
 * 权威站点目录：id → { label, domains, category }
 * 只放"编程 / 人工智能"方向可信来源；域名为 Tavily include_domains 的实际取值。
 */
const SITES = {
  csdn:            { label: 'CSDN（中文技术社区）',      domains: ['csdn.net'],            category: '中文社区' },
  juejin:          { label: '掘金（中文技术社区）',      domains: ['juejin.cn'],           category: '中文社区' },
  infoq:           { label: 'InfoQ 中文',                domains: ['infoq.cn'],            category: '中文社区' },
  jiqizhixin:      { label: '机器之心（AI 媒体）',       domains: ['jiqizhixin.com'],      category: '中文社区' },
  zhihu:           { label: '知乎',                      domains: ['zhihu.com'],           category: '中文社区' },
  github:          { label: 'GitHub',                    domains: ['github.com'],          category: '代码托管' },
  stackoverflow:   { label: 'Stack Overflow',            domains: ['stackoverflow.com'],   category: '问答' },
  mdn:             { label: 'MDN Web Docs',              domains: ['developer.mozilla.org'], category: '官方文档' },
  python:          { label: 'Python 官方文档',           domains: ['docs.python.org'],     category: '官方文档' },
  pypi:            { label: 'PyPI',                      domains: ['pypi.org'],            category: '包索引' },
  pytorch:         { label: 'PyTorch 官方文档',          domains: ['pytorch.org'],         category: 'AI 框架' },
  tensorflow:      { label: 'TensorFlow 官方文档',       domains: ['tensorflow.org'],      category: 'AI 框架' },
  huggingface:     { label: 'Hugging Face',              domains: ['huggingface.co'],      category: 'AI 模型/数据集' },
  openai:          { label: 'OpenAI 官方',               domains: ['platform.openai.com', 'openai.com'], category: 'AI 厂商' },
  anthropic:       { label: 'Anthropic 官方',            domains: ['docs.anthropic.com', 'anthropic.com'], category: 'AI 厂商' },
  arxiv:           { label: 'arXiv 论文库',              domains: ['arxiv.org'],           category: '论文' },
  realpython:      { label: 'Real Python',               domains: ['realpython.com'],      category: '教程' },
  geeksforgeeks:   { label: 'GeeksforGeeks',             domains: ['geeksforgeeks.org'],   category: '教程' },
};

const cat = (s) => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

/** 解析 site 参数 → 域名数组（已知 id 用目录；否则按字面域名兜底） */
function resolveDomains(site) {
  if (!site) return null; // 不限定 = 全站检索由 Tavily 决定
  const key = String(site).trim().toLowerCase();
  if (SITES[key]) return SITES[key].domains;
  const d = cat(site);
  return d && d.includes('.') ? [d] : null;
}

async function tavilySearch(query, domains, maxResults) {
  if (!TAVILY_KEY) throw new Error('未配置 TAVILY_API_KEY');
  const body = {
    query,
    max_results: Math.min(Math.max(Number(maxResults) || 5, 1), 8),
    search_depth: 'basic',
  };
  if (domains && domains.length) body.include_domains = domains;
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TAVILY_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  return res.json();
}

async function githubApi(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub API 触发限流，请稍后再试（或配置 GITHUB_TOKEN 提高配额）');
  if (res.status === 401) throw new Error('GitHub 代码检索需要登录：请配置 GITHUB_TOKEN');
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res.json();
}

const textResult = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const errResult = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

/* ----------------------------------- 启动 ----------------------------------- */

const server = new McpServer({ name: NAME, version: VERSION });

server.registerTool(
  'list_dev_sites',
  {
    title: '站点目录',
    description: '列出本服务支持的编程 / 人工智能权威站点（id、名称、域名、分类）。想限定在某站检索时，用它确认可用的 site 取值。不访问外网。',
    inputSchema: {},
  },
  async () => textResult({
    server: NAME,
    version: VERSION,
    sites: Object.entries(SITES).map(([id, s]) => ({ id, label: s.label, domains: s.domains, category: s.category })),
    note: 'search_dev 的 site 参数可传上述 id；也可直接传任意域名（如 example.com）。',
  })
);

server.registerTool(
  'search_dev',
  {
    title: '权威站点检索',
    description:
      '在编程 / 人工智能权威站点内检索（可用 site 限定单个站点，如 csdn、github、mdn、pytorch；不传则在这些权威站点范围内综合检索）。'
      + '返回标题、链接与摘要。适合查"某技术的中文教程/官方文档/最新论文"。查完可再用读网页工具取正文。',
    inputSchema: {
      query: z.string().describe('检索关键词，尽量具体（如 "Python 3.13 JIT 编译"）'),
      site: z.string().optional().describe('限定的站点 id 或域名（csdn / github / mdn / pytorch …）；不传则在全部权威站点内检索'),
      maxResults: z.number().int().min(1).max(8).optional().describe('返回条数，默认 5'),
    },
  },
  async ({ query, site, maxResults }) => {
    const q = String(query || '').trim();
    if (!q) return errResult('query 不能为空');
    const domains = resolveDomains(site);
    if (site && !domains) return errResult(`无法识别的站点：${site}（可先用 list_dev_sites 查看，或传完整域名）`);
    try {
      const data = await tavilySearch(q, domains, maxResults);
      const results = (data.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        content: (r.content || '').slice(0, 500),
      }));
      return textResult({
        query: q,
        site: site || '（权威站点综合）',
        domains: domains || null,
        count: results.length,
        results,
        note: results.length ? undefined : '该站点内未检索到相关内容，可换个关键词或去掉 site 限定。',
      });
    } catch (e) {
      console.error(`[${NAME}] search_dev 失败: ${e.message} | ${q}`);
      return errResult(`检索失败：${e.message}`);
    }
  }
);

server.registerTool(
  'github_search',
  {
    title: 'GitHub 检索',
    description:
      '检索 GitHub 上的仓库 / 代码 / issue（type=repo 找项目，type=code 查代码片段，type=issue 查讨论）。'
      + '找"某个库怎么用/有没有现成实现/这个报错别人怎么解决"时很合适。代码检索需要配置 GITHUB_TOKEN。',
    inputSchema: {
      query: z.string().describe('检索关键词，可用 GitHub 检索语法（如 "fastapi jwt stars:>1000"）'),
      type: z.enum(['repo', 'code', 'issue']).optional().describe('检索类型：repo=仓库（默认）/ code=代码 / issue=讨论'),
      maxResults: z.number().int().min(1).max(10).optional().describe('返回条数，默认 5'),
    },
  },
  async ({ query, type, maxResults }) => {
    const q = String(query || '').trim();
    if (!q) return errResult('query 不能为空');
    const kind = type || 'repo';
    const per = Math.min(Math.max(Number(maxResults) || 5, 1), 10);
    try {
      if (kind === 'repo') {
        const data = await githubApi(`/search/repositories?q=${encodeURIComponent(q)}&per_page=${per}&sort=stars`);
        const results = (data.items || []).map((r) => ({
          name: r.full_name,
          url: r.html_url,
          description: r.description,
          stars: r.stargazers_count,
          language: r.language,
          updatedAt: r.updated_at,
        }));
        return textResult({ query: q, type: 'repo', count: results.length, results });
      }
      if (kind === 'code') {
        if (!GITHUB_TOKEN) return errResult('GitHub 代码检索需要 GITHUB_TOKEN（未配置）。可改用 type=repo 或 type=issue。');
        const data = await githubApi(`/search/code?q=${encodeURIComponent(q)}&per_page=${per}`);
        const results = (data.items || []).map((r) => ({
          name: r.repository && r.repository.full_name,
          path: r.path,
          url: r.html_url,
        }));
        return textResult({ query: q, type: 'code', count: results.length, results });
      }
      const data = await githubApi(`/search/issues?q=${encodeURIComponent(q)}&per_page=${per}&sort=reactions`);
      const results = (data.items || []).map((r) => ({
        title: r.title,
        url: r.html_url,
        state: r.state,
        comments: r.comments,
        repo: r.repository_url && r.repository_url.split('/').slice(-2).join('/'),
      }));
      return textResult({ query: q, type: 'issue', count: results.length, results });
    } catch (e) {
      console.error(`[${NAME}] github_search 失败: ${e.message} | ${q}`);
      return errResult(`GitHub 检索失败：${e.message}`);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${NAME}] v${VERSION} 已就绪（pid=${process.pid}，tavily=${TAVILY_KEY ? 'on' : 'off'}，githubToken=${GITHUB_TOKEN ? 'on' : 'off'}，站点=${Object.keys(SITES).length}）`);
}

main().catch((e) => {
  console.error(`[${NAME}] 启动失败:`, e && e.stack ? e.stack : e);
  process.exit(1);
});
