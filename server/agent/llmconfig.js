/**
 * llmconfig.js — LLM 接入配置（首次进入的"配置 API Key"向导 + 多平台适配）
 * ---------------------------------------------------------------------------
 * 为什么需要它：
 *   项目原本靠手改 .env 才能接入真实模型，上线后要求"用户进入前弹窗配置 Key"。
 *   本模块提供：平台预设 → 拉取模型列表 → 测试连通 → 落盘 .env → 运行时热生效。
 *
 * 设计要点：
 *   1) 官网核对过的模型提供离线选项，账户模型列表通过 GET {base}/models 刷新。
 *      能力声明来自官网或官方结构化元数据，未确认的模型不按名称猜测。
 *   2) 密钥只写不读：GET 接口一律返回掩码（sk-***abcd），明文永不回传前端。
 *      服务默认只监听 127.0.0.1（见 index.js HOST），且本模块额外校验来源为本机。
 *   3) 落盘 .env 时按行改写、保留注释与其他配置，不做整体覆盖（避免抹掉用户的
 *      TAVILY_API_KEY 等其它设置）。
 *   4) 保存后立即写 process.env —— llm.js 每次调用都现读 process.env，
 *      因此无需重启即可生效。同时同步更新 .env.example 未覆盖的项。
 */

const fs = require('fs');
const path = require('path');
const modelCapabilities = require('./modelCapabilities');

const ROOT = path.join(__dirname, '..', '..');
/** .env 路径：可用 EDUOWL_ENV_FILE 覆盖（测试隔离用，避免并行测试读写同一文件串号） */
function envFilePath() {
  return process.env.EDUOWL_ENV_FILE || path.join(ROOT, '.env');
}
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const discoveredCapabilities = new Map();

function modelKey({ provider, baseUrl, model } = {}) {
  return `${modelCapabilities.providerKey(provider, baseUrl)}|${normalizeBase(baseUrl)}|${String(model || '').trim()}`;
}

function capability(input = {}) {
  const key = modelKey(input);
  if (discoveredCapabilities.has(key)) return discoveredCapabilities.get(key);
  const detected = modelCapabilities.detect(input);
  try {
    const saved = JSON.parse(process.env.LLM_MODEL_CAPABILITY || '{}');
    if (saved.key === key && saved.capability && (detected.confidence !== 'official'
      || (saved.capability.confidence === 'official' && saved.capability.checkedAt >= detected.checkedAt))) return saved.capability;
  } catch (_) {}
  return detected;
}

/**
 * 平台预设。
 * baseUrl 均为各平台官方文档给出的 OpenAI 兼容地址（本项目已实测可达：
 * 多数返回 401「密钥无效」而非 404，说明端点正确）。
 * 注意：不带 key，用户需自行到平台申请；docs 字段给出申请入口。
 */
const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    docs: 'https://platform.deepseek.com/api_keys',
    note: 'Flash 支持文字与图片；V4 Pro 仅支持文字。模型权限以账户为准。',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼（通义千问 Qwen）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    docs: 'https://bailian.console.aliyun.com/',
    note: '模型最全（含 Qwen / Kimi / GLM 等托管版）；注意密钥与区域绑定',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    docs: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'GLM 视觉版与文本版分别标注；注意服务地址包含 /paas/v4。',
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    docs: 'https://platform.kimi.com/console/api-keys',
    note: '当前 Kimi 模型支持文字、图片与视频；旧版 Moonshot V1 已退役。',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    docs: 'https://cloud.siliconflow.cn/account/ak',
    note: '提供托管模型；请刷新账户模型列表，权限与能力以所选模型为准。',
  },
  {
    id: 'ark',
    name: '火山方舟（豆包 Doubao）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    docs: 'https://console.volcengine.com/ark',
    note: '可选择官方 Model ID；私有推理接入点需刷新账户列表，能力单独确认。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    docs: 'https://platform.openai.com/api-keys',
    note: '推理型模型（o 系列 / gpt-5 系）可能限制 temperature 且需 max_completion_tokens',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter（聚合）',
    baseUrl: 'https://openrouter.ai/api/v1',
    docs: 'https://openrouter.ai/keys',
    note: '模型输入能力来自 OpenRouter 官方模型目录；一个 Key 可访问多家模型。',
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容服务',
    baseUrl: '',
    docs: '',
    note: '填写兼容服务地址后刷新模型列表，再从下拉菜单选择模型。',
  },
];
for (const preset of PROVIDERS) {
  preset.models = modelCapabilities.catalog(preset.id, preset.baseUrl);
}

/** 平台 id → 预设（未知名按 custom 处理） */
function providerOf(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS.find((p) => p.id === 'custom');
}

/** 掩码：只露头尾，避免明文回传/日志泄漏 */
function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 10) return s.slice(0, 2) + '***';
  return `${s.slice(0, 5)}***${s.slice(-4)}`;
}

/** 规范化 base：去尾斜杠（调用处统一拼 /chat/completions 或 /models） */
function normalizeBase(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

/** 反查当前 baseUrl 属于哪个平台预设（用户没显式选平台时用） */
function inferProviderId(baseUrl) {
  const b = normalizeBase(baseUrl);
  if (!b) return 'custom';
  const hit = PROVIDERS.find((p) => p.baseUrl && normalizeBase(p.baseUrl) === b);
  return hit ? hit.id : 'custom';
}

// A saved key may only be reused for its original provider and endpoint.
function savedKeyFor(provider, baseUrl) {
  const currentBase = normalizeBase(process.env.LLM_BASE_URL || '');
  const currentProvider = process.env.LLM_PROVIDER || inferProviderId(currentBase);
  return normalizeBase(baseUrl) === currentBase && (!provider || provider === currentProvider)
    ? String(process.env.LLM_API_KEY || '').trim() : '';
}

/** 读取当前生效配置（不含明文密钥） */
function getConfig() {
  const apiKey = process.env.LLM_API_KEY || '';
  const baseUrl = normalizeBase(process.env.LLM_BASE_URL || '');
  const provider = process.env.LLM_PROVIDER || inferProviderId(baseUrl);
  const model = process.env.LLM_MODEL || '';
  return {
    configured: !!apiKey,
    mode: process.env.LLM_MODE === 'mock' ? 'mock' : (apiKey ? 'api' : 'mock'),
    provider,
    baseUrl,
    model,
    hasKey: !!apiKey,
    keyMasked: maskKey(apiKey),
    disableThinking: process.env.LLM_DISABLE_THINKING === '1',
    modelCapability: capability({ provider, baseUrl, model }),
    // 用户显式选择过"保持离线演示"→ 不再反复弹配置引导
    skipped: process.env.LLM_SETUP_SKIPPED === '1',
  };
}

/**
 * 按行改写 .env：只覆盖/追加指定键，保留注释与其它配置。
 * 为什么不用整体重写：.env 里有 TAVILY_API_KEY 等其它配置，整体覆盖会丢数据。
 */
function writeEnvKeys(pairs) {
  let lines = [];
  try { lines = fs.readFileSync(envFilePath(), 'utf8').split(/\r?\n/); } catch (_) { lines = []; }
  const pending = new Map(Object.entries(pairs).filter(([, v]) => v !== undefined));
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const eq = t.indexOf('=');
    if (eq < 1) return line;
    const key = t.slice(0, eq).trim();
    if (!pending.has(key)) return line;
    const val = pending.get(key);
    pending.delete(key);
    return `${key}=${val}`;
  });
  // 未出现过的键追加到末尾（同一块内，便于用户查看）
  if (pending.size) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push('# ---------- LLM 接入（由配置向导写入） ----------');
    for (const [k, v] of pending) out.push(`${k}=${v}`);
  }
  fs.writeFileSync(envFilePath(), out.join('\n'), 'utf8');
}

/**
 * 保存配置并热生效。
 * @param {{provider?:string, baseUrl?:string, model?:string, apiKey?:string, disableThinking?:boolean}} input
 * @returns {{ok:boolean, error?:string, config?:object}}
 */
function saveConfig(input = {}) {
  const providerId = String(input.provider || '').trim();
  const preset = providerOf(providerId);
  // 自定义平台必须自带 baseUrl；预设平台允许用户改（代理/私有化部署）
  const baseUrl = normalizeBase(input.baseUrl || preset.baseUrl || '');
  const model = String(input.model || '').trim();
  const apiKey = input.apiKey === undefined ? undefined : String(input.apiKey).trim();

  if (providerId && !PROVIDERS.some((p) => p.id === providerId)) return { ok: false, error: '请选择有效的模型供应商' };
  if (!baseUrl) return { ok: false, error: '请填写服务地址（base_url）' };
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: '服务地址需以 http:// 或 https:// 开头' };
  if (!model) return { ok: false, error: '请选择模型' };
  if (apiKey !== undefined && !apiKey) return { ok: false, error: '请填写 API Key' };
  if (apiKey !== undefined && /[\r\n]/.test(apiKey)) return { ok: false, error: 'API Key 格式无效' };
  if (/[\r\n]/.test(baseUrl + model)) return { ok: false, error: '服务地址或模型名格式无效' };
  if (!apiKey && !savedKeyFor(preset.id, baseUrl)) return { ok: false, error: '请填写所选供应商的 API Key；切换供应商或服务地址后不能沿用原密钥' };

  const pairs = {
    LLM_PROVIDER: preset.id,
    LLM_BASE_URL: baseUrl,
    LLM_MODEL: model,
    LLM_MODEL_CAPABILITY: JSON.stringify({ key: modelKey({ provider: preset.id, baseUrl, model }), capability: capability({ provider: preset.id, baseUrl, model }) }),
    LLM_SETUP_SKIPPED: '', // 配置成功即清除"跳过"标记
  };
  if (apiKey !== undefined) pairs.LLM_API_KEY = apiKey;
  if (input.disableThinking !== undefined) pairs.LLM_DISABLE_THINKING = input.disableThinking ? '1' : '';
  // 之前若被强制 mock，配置真实 Key 后要解除，否则保存了却不生效
  if (apiKey) pairs.LLM_MODE = '';

  try {
    writeEnvKeys(pairs);
  } catch (e) {
    return { ok: false, error: '写入 .env 失败：' + e.message };
  }
  // 热生效：llm.js 每次调用现读 process.env，故改写后无需重启
  process.env.LLM_PROVIDER = preset.id;
  process.env.LLM_BASE_URL = baseUrl;
  process.env.LLM_MODEL = model;
  process.env.LLM_MODEL_CAPABILITY = pairs.LLM_MODEL_CAPABILITY;
  process.env.LLM_SETUP_SKIPPED = '';
  if (apiKey !== undefined) process.env.LLM_API_KEY = apiKey;
  if (input.disableThinking !== undefined) {
    if (input.disableThinking) process.env.LLM_DISABLE_THINKING = '1';
    else delete process.env.LLM_DISABLE_THINKING;
  }
  if (apiKey) delete process.env.LLM_MODE;

  const out = getConfig();
  try { fs.writeFileSync(ENV_EXAMPLE, fs.readFileSync(ENV_EXAMPLE, 'utf8'), 'utf8'); } catch (_) { /* 模板不动 */ }
  return { ok: true, config: out };
}

/** 用户选择"继续使用离线演示"：不再弹配置引导（可从顶部随时重新配置） */
function skipSetup() {
  try {
    writeEnvKeys({ LLM_SETUP_SKIPPED: '1' });
  } catch (e) {
    return { ok: false, error: '写入 .env 失败：' + e.message };
  }
  process.env.LLM_SETUP_SKIPPED = '1';
  return { ok: true, config: getConfig() };
}

/** 统一错误信息：把上游原始报错转成用户能看懂的中文提示 */
function friendlyError(status, text) {
  const raw = String(text || '').slice(0, 300);
  const low = raw.toLowerCase();
  if (status === 401 || /invalid.*(api.?key|token)|authentication|unauthorized|密钥|令牌|token is invalid/i.test(raw)) {
    return 'API Key 无效或已过期，请到平台重新申请后填入';
  }
  if (status === 403) return '该 Key 无权限访问此模型（可能是未开通或欠费）';
  if (status === 404) return '服务地址或模型名不正确（请检查 base_url 是否包含 /v1 之类的版本路径）';
  if (status === 429 || /rate.?limit|quota|exceed/i.test(low)) return '请求过于频繁或额度不足，请稍后再试或检查账户余额';
  if (status >= 500) return '平台服务端暂时异常，请稍后重试';
  return `平台返回错误 ${status}：${raw}`;
}

/** 拉取模型列表（GET {base}/models） */
async function listModels({ provider, baseUrl, apiKey } = {}) {
  const base = normalizeBase(baseUrl || process.env.LLM_BASE_URL || '');
  const publicCatalog = base === providerOf('openrouter').baseUrl && modelCapabilities.providerKey(provider, base) === 'openrouter';
  const key = publicCatalog ? '' : String(apiKey || savedKeyFor(provider, base)).trim();
  if (!base) return { ok: false, error: '请先填写服务地址' };
  if (!key && !publicCatalog) return { ok: false, error: '请先填写 API Key' };
  let res;
  try {
    res = await fetch(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { ok: false, error: '连接失败：' + (e.name === 'TimeoutError' ? '请求超时（20s）' : e.message) };
  }
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch (_) {}
    return { ok: false, error: friendlyError(res.status, text) };
  }
  let data;
  try { data = await res.json(); } catch (_) { return { ok: false, error: '平台返回内容无法解析（期望 JSON）' }; }
  const arr = Array.isArray(data) ? data : (data.data || data.models || []);
  if (!Array.isArray(arr)) return { ok: false, error: '平台返回内容无法解析（期望 JSON）' };
  const providerId = modelCapabilities.providerKey(provider, base);
  const ids = [];
  for (const entry of arr) {
    const model = typeof entry === 'string' ? entry : entry && (entry.id || entry.name || entry.model);
    if (typeof model !== 'string' || !model.trim()) continue;
    // Only the actual official OpenRouter endpoint supplies trusted modality metadata.
    if (providerId === 'openrouter' && base === providerOf('openrouter').baseUrl && Array.isArray(entry.architecture?.input_modalities)) {
      const declared = modelCapabilities.fromModalities(providerId, entry.architecture.input_modalities, `${base}/models`, new Date().toISOString().slice(0, 10));
      if (!declared || (Array.isArray(entry.architecture.output_modalities) && !entry.architecture.output_modalities.includes('text'))) continue;
      discoveredCapabilities.set(modelKey({ provider: providerId, baseUrl: base, model }), declared);
    }
    ids.push(model);
  }
  const unique = [...new Set(ids)].sort();
  const modelCapabilitiesList = unique.map((model) => ({
    model,
    capability: capability({ provider: providerId, baseUrl: base, model }),
  }));
  return { ok: true, count: unique.length, models: unique, modelCapabilities: modelCapabilitiesList };
}

/**
 * 连通性测试：发一次最小对话请求（非流式），返回延迟与模型实际回显。
 * 这是"保存前先验证"的关键 —— 避免用户存了错的 Key，之后每轮对话都失败。
 */
async function testConnection({ provider, baseUrl, model, apiKey, testVision = false } = {}) {
  const base = normalizeBase(baseUrl || process.env.LLM_BASE_URL || '');
  const m = String(model || process.env.LLM_MODEL || '').trim();
  const key = String(apiKey || savedKeyFor(provider, base)).trim();
  if (!base) return { ok: false, error: '请先填写服务地址' };
  if (!m) return { ok: false, error: '请先选择模型' };
  if (!key) return { ok: false, error: '请先填写 API Key' };
  const selected = capability({ provider, baseUrl: base, model: m });
  if (testVision && selected.vision === false) return { ok: false, error: '官方资料确认该模型不支持图片输入' };

  const body = {
    model: m,
    messages: testVision
      ? [{ role: 'user', content: [
          { type: 'text', text: 'Reply with the word OK after inspecting this image.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } },
        ] }]
      : [{ role: 'user', content: 'ping' }],
    stream: false,
    ...((selected.provider === 'moonshot' && m === 'kimi-k2.6') || (selected.provider === 'siliconflow' && m === 'Pro/moonshotai/Kimi-K2.6') ? { thinking: { type: 'disabled' } } : {}),
  };
  if (modelCapabilities.providerKey(provider, base) === 'openai') body.max_completion_tokens = 256;
  else body.max_tokens = 256;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, error: '连接失败：' + (e.name === 'TimeoutError' ? '请求超时（30s）' : e.message) };
  }
  const ms = Date.now() - t0;
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch (_) {}
    return { ok: false, error: friendlyError(res.status, text), elapsedMs: ms };
  }
  let data;
  try { data = await res.json(); } catch (_) { return { ok: false, error: '平台返回内容无法解析（期望 JSON）', elapsedMs: ms }; }
  // 有一类平台 200 但 body 里带 error（如额度用尽）
  if (data.error) return { ok: false, error: friendlyError(res.status, JSON.stringify(data.error)), elapsedMs: ms };
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '') : '';
  if (!data.choices?.[0]?.message) return { ok: false, error: '平台返回内容无法解析（期望 JSON）', elapsedMs: ms };
  const tested = selected.vision === null ? { ...selected, vision: true, confidence: 'tested' } : selected;
  if (testVision && selected.vision === null) discoveredCapabilities.set(modelKey({ provider, baseUrl: base, model: m }), tested);
  return {
    ok: true,
    elapsedMs: ms,
    model: data.model || m,
    replyPreview: content.slice(0, 60),
    usage: data.usage || null,
    ...(testVision ? { vision: { tested: true, supported: true }, modelCapability: tested } : {}),
  };
}

module.exports = { PROVIDERS, providerOf, inferProviderId, getConfig, saveConfig, skipSetup, listModels, testConnection, capability, maskKey, normalizeBase, friendlyError };
