'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { resolvePython } = require('../python');

function callCore(command, payload = {}) {
  const input = JSON.stringify({ command, payload });
  if (Buffer.byteLength(input) > 2000000) throw Object.assign(new Error('Learning rule input is too large.'), { code: 'HARNESS_INPUT_TOO_LARGE', status: 413 });
  const result = spawnSync(resolvePython(), [path.join(__dirname, 'engine.py')], {
    input, encoding: 'utf8', timeout: 5000, maxBuffer: 2100000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw Object.assign(new Error('Python learning rules are unavailable. Check the Python installation.'), { code: 'HARNESS_CORE_UNAVAILABLE', status: 503 });
  try {
    const value = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') throw new Error('invalid output');
    return value;
  } catch (_) {
    throw Object.assign(new Error('Python learning rules returned an invalid response.'), { code: 'HARNESS_CORE_INVALID', status: 503 });
  }
}
module.exports = { callCore };
