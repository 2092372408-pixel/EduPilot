const { providerKey } = require('./modelCapabilities');

// Only documented, switchable model families on their official endpoints.
const rules = {
  dashscope: [/^(?:qwen-(?:plus(?:-latest)?|flash)|qwen3\.(?:5-(?:plus|flash)|6-(?:plus|flash)|7-(?:max|plus|flash)|8-(?:max|flash))(?:-\d{2,4}(?:-\d{2}-\d{2})?)?)$/, 'boolean'],
  deepseek: [/^(?:deepseek-flash|deepseek-v4-(?:flash|pro))$/, 'type'],
  zhipu: [/^glm-(?:4\.7|4\.7-flashx|5(?:\.1|\.2|-turbo)?)$/, 'type'],
  moonshot: [/^kimi-k2\.6$/, 'type'],
  siliconflow: [/^Qwen\/Qwen3-(?:8B|32B)$/, 'boolean'],
  ark: [/^doubao-seed-(?:1-8-251228|2-1-(?:pro-260915|lite-260915|turbo-260628))$/, 'type'],
  openai: [/^gpt-5\.(?:1|2)(?:-\d{4}-\d{2}-\d{2})?$/, 'effort'],
  openrouter: [/^qwen\/qwen3\.5-plus-20260420$/, 'router'],
};

function modelRequest({ baseUrl, model, enabled } = {}) {
  // The actual host determines the protocol even if the selected preset is stale.
  const id = providerKey(undefined, baseUrl);
  const rule = rules[id];
  const format = rule?.[0].test(model) ? rule[1] : null;
  const defaultEnabled = id === 'dashscope' && /^qwen3\./.test(model) && process.env.LLM_DISABLE_THINKING !== '1';
  const thinking = typeof enabled === 'boolean' ? enabled : defaultEnabled;
  const hostedKimi = id === 'siliconflow' && model === 'Pro/moonshotai/Kimi-K2.6';
  const params = id === 'dashscope' ? { enable_search: false }
    : id === 'openrouter' ? { plugins: [{ id: 'web', enabled: false }] } : {};
  if (format === 'boolean') params.enable_thinking = thinking;
  if (format === 'type') params.thinking = { type: thinking ? 'enabled' : 'disabled' };
  if (hostedKimi) params.thinking = { type: 'disabled' };
  if (format === 'effort') params.reasoning_effort = thinking ? 'medium' : 'none';
  if (format === 'router' || (id === 'openrouter' && model === 'qwen/qwen3.5-flash-02-23')) {
    // This Flash endpoint puts reasoning in content even with exclude set.
    params.reasoning = { enabled: format === 'router' && thinking, exclude: true };
    params.provider = { require_parameters: true };
  }
  return {
    id, params, thinking: { supported: !!format, enabled: !!format && thinking },
    completionLimit: ['openai', 'moonshot', 'ark'].includes(id),
    omitTemperature: id === 'moonshot' || hostedKimi || (id === 'openai' && /^(?:o[1-9]|gpt-[56])/i.test(model)),
    streamUsage: ['deepseek', 'openai', 'dashscope', 'moonshot', 'ark'].includes(id),
    replayReasoning: !!format && thinking && ['deepseek', 'moonshot', 'zhipu', 'ark'].includes(id),
  };
}

module.exports = { modelRequest };
