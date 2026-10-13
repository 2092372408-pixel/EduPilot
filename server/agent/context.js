/**
 * context.js - bounded context selection shared by legacy ReAct and LangGraph.
 *
 * This is deliberately an estimate rather than a provider-specific tokenizer:
 * providers expose different tokenizers, while a conservative character-based
 * budget is still better than an unbounded request that fails at the gateway.
 */

const DEFAULT_CONTEXT_TOKENS = 12000;

function contextLimit() {
  const n = Number(process.env.LLM_CONTEXT_TOKENS);
  return Number.isFinite(n) && n >= 4000 ? Math.floor(n) : DEFAULT_CONTEXT_TOKENS;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text') return String(part.text || '');
    if (part.type === 'image_url') return '[image]';
    return String(part.content || '');
  }).join('\n');
}

function estimateTokens(value) {
  const text = contentText(value);
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) if (/[一-龥]/.test(ch)) cjk += 1;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function roleOf(message) {
  if (!message) return '';
  if (message.role) return message.role;
  if (message.type) return message.type;
  if (typeof message._getType === 'function') return message._getType();
  return '';
}

/** Keep every system message, then keep the newest non-system messages that fit. */
function trimMessages(messages, maxTokens = contextLimit()) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const systemCost = messages
    .filter((m) => roleOf(m) === 'system')
    .reduce((sum, m) => sum + estimateTokens(m.content), 0);
  let budget = Math.max(0, maxTokens - systemCost);
  const keep = new Set();

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || roleOf(message) === 'system') continue;
    const cost = estimateTokens(message.content);
    if (cost <= budget || keep.size === 0) {
      keep.add(i);
      budget = Math.max(0, budget - cost);
    }
  }

  return messages.filter((message, i) => message && (roleOf(message) === 'system' || keep.has(i)));
}

module.exports = { contextLimit, contentText, estimateTokens, trimMessages };
