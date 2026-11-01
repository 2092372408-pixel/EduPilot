// Search uses the configured model's key. The chat switch is the only opt-in.
require('../env');
function getConfig() {
  const capability = require('./native-search').capability();
  const hasKey = !!String(process.env.LLM_API_KEY || '').trim();
  return { ...capability, enabled: hasKey, hasKey };
}
module.exports = { getConfig };
