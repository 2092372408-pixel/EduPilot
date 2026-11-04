// Request cancellation follows nested model/tool calls without changing their public signatures.
const { AsyncLocalStorage } = require('node:async_hooks');
const signals = new AsyncLocalStorage();

function currentSignal() { return signals.getStore()?.signal; }
function currentThinking() { return signals.getStore()?.thinking; }
function throwIfAborted() { currentSignal()?.throwIfAborted(); }
function runWithSignal(signal, fn, thinking) { return signals.run({ signal, thinking }, fn); }

module.exports = { currentSignal, currentThinking, throwIfAborted, runWithSignal };
