// Request cancellation follows nested model/tool calls without changing their public signatures.
const { AsyncLocalStorage } = require('node:async_hooks');
const signals = new AsyncLocalStorage();

function currentSignal() { return signals.getStore(); }
function throwIfAborted() { currentSignal()?.throwIfAborted(); }
function runWithSignal(signal, fn) { return signals.run(signal, fn); }

module.exports = { currentSignal, throwIfAborted, runWithSignal };
