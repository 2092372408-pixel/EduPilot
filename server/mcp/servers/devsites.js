#!/usr/bin/env node
/**
 * mcp/servers/devsites.js — 自建 MCP Server（stdio）：编程 / AI 权威站点专属接入
 * ------------------------------------------------------------
 * 与通用联网搜索的区别：这里把「**去哪些站、按什么口径查**」钉死在服务端，
 * 模型只表达"想查什么、想查哪个站"，避免它自由发挥去读不可信来源（教学场景更可控）。
 *
 * 暴露工具：
 *   list_dev_sites  站点目录（零外网依赖，供模型/自检了解可用站点，也是连通性探测）
 *   github_search   GitHub 仓库 / 代码 / issue 检索（走 GitHub 官方 REST API，独立配额）
 *
 * 凭证：GITHUB_TOKEN 可选（提高 GitHub 搜索配额）。
 * 注意：stdio 传输下 **stdout 是协议通道**，本进程任何日志只能走 stderr。
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const NAME = 'eduowl-devsites';
const VERSION = '1.0.0';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TIMEOUT_MS = 20000;
const UA = 'EduPilotBot/1.0 (+local teaching agent)';

/**
 * 权威站点目录：id → { label, domains, category }
 * 只放"编程 / 人工智能"方向可信来源；列出可信来源域名。
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

async function githubApi(path, signal) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
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
  })
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
  async ({ query, type, maxResults }, extra) => {
    const q = String(query || '').trim();
    if (!q) return errResult('query 不能为空');
    const kind = type || 'repo';
    const per = Math.min(Math.max(Number(maxResults) || 5, 1), 10);
    try {
      if (kind === 'repo') {
        const data = await githubApi(`/search/repositories?q=${encodeURIComponent(q)}&per_page=${per}&sort=stars`, extra.signal);
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
        const data = await githubApi(`/search/code?q=${encodeURIComponent(q)}&per_page=${per}`, extra.signal);
        const results = (data.items || []).map((r) => ({
          name: r.repository && r.repository.full_name,
          path: r.path,
          url: r.html_url,
        }));
        return textResult({ query: q, type: 'code', count: results.length, results });
      }
      const data = await githubApi(`/search/issues?q=${encodeURIComponent(q)}&per_page=${per}&sort=reactions`, extra.signal);
      const results = (data.items || []).map((r) => ({
        title: r.title,
        url: r.html_url,
        state: r.state,
        comments: r.comments,
        repo: r.repository_url && r.repository_url.split('/').slice(-2).join('/'),
      }));
      return textResult({ query: q, type: 'issue', count: results.length, results });
    } catch (e) {
      extra.signal.throwIfAborted();
      console.error(`[${NAME}] github_search 失败: ${e.message} | ${q}`);
      return errResult(`GitHub 检索失败：${e.message}`);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${NAME}] v${VERSION} 已就绪（pid=${process.pid}，githubToken=${GITHUB_TOKEN ? 'on' : 'off'}，站点=${Object.keys(SITES).length}）`);
}

main().catch((e) => {
  console.error(`[${NAME}] 启动失败:`, e && e.stack ? e.stack : e);
  process.exit(1);
});
