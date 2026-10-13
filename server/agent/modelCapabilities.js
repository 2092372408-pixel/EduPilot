// Exact model IDs and input modalities checked against provider documentation.
// A model's name alone is never evidence of its capabilities.
const CHECKED_AT = '2026-10-08';
const HOSTS = {
  deepseek: ['api.deepseek.com'],
  openai: ['api.openai.com'],
  dashscope: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'],
  zhipu: ['open.bigmodel.cn'],
  moonshot: ['api.moonshot.cn', 'api.moonshot.ai'],
  siliconflow: ['api.siliconflow.cn', 'api.siliconflow.com'],
  ark: ['ark.cn-beijing.volces.com'],
  openrouter: ['openrouter.ai'],
  custom: [],
};
const CATALOG = {
  deepseek: [
    [['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'], ['text', 'image'], 'https://api-docs.deepseek.com/guides/vision/'],
    [['deepseek-v4-pro'], ['text'], 'https://api-docs.deepseek.com/quick_start/pricing/'],
  ],
  openai: [
    [['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'], ['text', 'image'], 'https://developers.openai.com/api/docs/models/gpt-4.1-mini'],
    [['gpt-4.1', 'gpt-4.1-2025-04-14'], ['text', 'image'], 'https://developers.openai.com/api/docs/models/gpt-4.1'],
    [['gpt-4.1-nano', 'gpt-4.1-nano-2025-04-14'], ['text', 'image'], 'https://developers.openai.com/api/docs/models/gpt-4.1-nano'],
    [['gpt-4o-mini', 'gpt-4o-mini-2024-07-18'], ['text', 'image'], 'https://developers.openai.com/api/docs/models/gpt-4o-mini'],
    [['gpt-4o'], ['text', 'image'], 'https://developers.openai.com/api/docs/models/gpt-4o'],
    [['gpt-5-mini', 'gpt-5-mini-2025-08-07'], ['text', 'image'], 'https://developers.openai.com/api/docs/models/gpt-5-mini'],
    [['gpt-5', 'gpt-5-2025-08-07'], ['text', 'image'], 'https://developers.openai.com/api/docs/models/gpt-5'],
    [['gpt-6-astra'], ['text', 'image'], 'https://developers.openai.com/api/docs/models/gpt-6-astra'],
    [['o3-mini', 'o3-mini-2025-01-31'], ['text'], 'https://developers.openai.com/api/docs/models/o3-mini'],
    [['gpt-4', 'gpt-4-0613', 'gpt-4-0314'], ['text'], 'https://developers.openai.com/api/docs/models/gpt-4'],
  ],
  dashscope: [
    [['qwen3.5-plus', 'qwen3.5-plus-2026-02-15', 'qwen3.5-plus-2026-04-20'], ['text', 'image', 'video'], 'https://help.aliyun.com/zh/model-studio/qwen3-5-plus'],
    [['qwen3.8-max', 'qwen3.7-plus'], ['text', 'image', 'video'], 'https://help.aliyun.com/zh/model-studio/models'],
    [['qwen3.8-omni-flash'], ['text', 'image', 'audio', 'video'], 'https://help.aliyun.com/zh/model-studio/models'],
    [['qwen-plus', 'qwen-plus-latest'], ['text'], 'https://help.aliyun.com/zh/model-studio/qwen-plus'],
  ],
  zhipu: [
    [['glm-5.3-flash', 'glm-5.3-flashx'], ['text', 'image', 'video'], 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash'],
    [['glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx'], ['text', 'image', 'video'], 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v'],
    [['glm-5.3'], ['text'], 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3'],
    [['glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx', 'glm-4.6', 'glm-4.5-air', 'glm-4.5-airx', 'glm-4.5-flash', 'glm-4-long', 'glm-4-flash-250414', 'glm-4-flashx-250414'], ['text'], 'https://docs.bigmodel.cn/cn/guide/start/model-overview'],
    [['glm-4.1v-thinking-flash', 'glm-4.1v-thinking-flashx', 'glm-4v-flash'], ['text', 'image'], 'https://docs.bigmodel.cn/cn/guide/start/model-overview'],
  ],
  moonshot: [
    [['kimi-k2.6'], ['text', 'image', 'video'], 'https://platform.kimi.com/docs/guide/use-kimi-vision-model'],
  ],
  siliconflow: [
    [['Pro/moonshotai/Kimi-K2.6'], ['text', 'image'], 'https://docs.siliconflow.cn/en/userguide/capabilities/vision'],
  ],
  ark: [
    [['doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-turbo-260628', 'deepseek-v4-1-flash-260910', 'glm-5-3-flash-260828'], ['text', 'image', 'video'], 'https://docs.volcengine.com/docs/ark/model-list'],
    [['doubao-seed-2-1-lite-260915'], ['text', 'image', 'video', 'audio'], 'https://docs.volcengine.com/docs/ark/model-list'],
    [['doubao-seed-character-251128', 'glm-5-2-260617', 'deepseek-v4-pro-ga-260813', 'deepseek-v4-flash-ga-260731'], ['text'], 'https://docs.volcengine.com/docs/ark/model-list'],
  ],
  openrouter: [
    [['openai/gpt-4o-mini'], ['text', 'image'], 'https://openrouter.ai/api/v1/models'],
    [['openai/o3-mini'], ['text'], 'https://openrouter.ai/api/v1/models'],
    [['google/gemini-2.5-flash'], ['text', 'image', 'audio', 'video'], 'https://openrouter.ai/api/v1/models'],
    [['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.6', 'anthropic/claude-haiku-4.5'], ['text', 'image'], 'https://openrouter.ai/api/v1/models'],
    [['google/gemini-3.8-flash', 'google/gemini-3.7-flash', 'google/gemini-3.6-flash', 'google/gemini-3.5-flash-lite', 'google/gemini-3.1-flash-lite', 'google/gemini-2.5-flash-lite', 'google/gemini-2.5-pro'], ['text', 'image', 'audio', 'video'], 'https://openrouter.ai/api/v1/models'],
    [['qwen/qwen3.8-max-prime', 'qwen/qwen3.8-max-0902', 'qwen/qwen3.8-flash', 'qwen/qwen3.8-27b', 'qwen/qwen3.5-plus-20260420', 'z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flashx', 'z-ai/glm-5v-turbo'], ['text', 'image', 'video'], 'https://openrouter.ai/api/v1/models'],
    [['qwen/qwen3.8-omni-flash'], ['text', 'image', 'audio', 'video'], 'https://openrouter.ai/api/v1/models'],
    [['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash-vision-exp'], ['text', 'image'], 'https://openrouter.ai/api/v1/models'],
    [['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-flash-0731', 'qwen/qwen3.8-2.4t-a95b', 'qwen/qwen3.7-max', 'qwen/qwen3-coder-next', 'z-ai/glm-5.3', 'z-ai/glm-5.3-prime', 'z-ai/glm-5.2', 'z-ai/glm-5.1'], ['text'], 'https://openrouter.ai/api/v1/models'],
  ],
  custom: [],
};

function providerKey(provider, baseUrl = '') {
  const explicit = Object.hasOwn(HOSTS, provider);
  if (!baseUrl) return explicit ? provider : 'custom';
  let hostname;
  try { hostname = new URL(baseUrl).hostname; } catch (_) { return 'custom'; }
  if (explicit) return HOSTS[provider].includes(hostname) ? provider : 'custom';
  return Object.keys(HOSTS).find(key => HOSTS[key].includes(hostname)) || 'custom';
}

function fromModalities(provider, inputs, sourceUrl, checkedAt = CHECKED_AT) {
  // "file" is a transport format, not a separate sensory modality.
  const inputModalities = [...new Set(inputs.filter(input => ['text', 'image', 'audio', 'video'].includes(input)))];
  if (!inputModalities.includes('text')) return null;
  return {
    provider, vision: inputModalities.includes('image'), confidence: 'official',
    modality: inputModalities.length > 1 ? 'multimodal' : 'single-modal',
    inputModalities, sourceUrl, checkedAt,
  };
}

function catalog(provider, baseUrl = '') {
  const key = providerKey(provider, baseUrl);
  return (CATALOG[key] || []).flatMap(([models, inputs, source]) => models.map(model => ({
    model, capability: fromModalities(key, inputs, source),
  })));
}

function detect({ provider, baseUrl, model } = {}) {
  const key = providerKey(provider, baseUrl);
  const entry = catalog(key).find(entry => entry.model === String(model || '').trim());
  return entry ? entry.capability : {
    provider: key, vision: null, confidence: 'unknown', modality: 'unknown',
    inputModalities: [], sourceUrl: '', checkedAt: '',
  };
}

function recommendations(provider, baseUrl = '') {
  return catalog(provider, baseUrl).filter(entry => entry.capability.vision).map(entry => entry.model);
}

module.exports = { detect, catalog, recommendations, providerKey, fromModalities };
