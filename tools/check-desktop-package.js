// Runs against a newly installed, isolated package launched without opening a
// system browser. Native release jobs and local download checks use this path.
const assert = require('node:assert/strict');
const base = process.argv[2] || 'http://127.0.0.1:18787';
const version = process.argv[3];
const streams = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const health = () => fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) }).then(r => r.json());

async function count(expected) {
  for (let i = 0; i < 30; i++) {
    if ((await health()).desktop.clients === expected) return;
    await delay(100);
  }
  assert.equal((await health()).desktop.clients, expected);
}

async function open() {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(base + '/api/desktop/events', { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  return controller;
}

(async () => {
  const initial = await health();
  assert.equal(initial.desktop.enabled, true);
  assert.equal(initial.desktop.clients, 0, 'check requires a package started with NoBrowser');
  if (version) assert.equal(initial.version, version);
  for (const page of ['/', '/upload.html', '/report.html', '/coding.html', '/choice.html', '/exam.html']) {
    assert.match(await (await fetch(base + page)).text(), /desktop-session\.js/, page);
  }
  assert.equal((await fetch(base + '/desktop-session.js')).status, 200);
  const first = await open(), second = await open();
  await count(2);
  first.abort(); await count(1);
  assert.equal((await health()).ok, true);
  second.abort(); await count(0);
  const refreshed = await open(); await count(1);
  assert.equal((await health()).ok, true);
  const started = Date.now();
  refreshed.abort(); await count(0);
  let stopped = false;
  for (let i = 0; i < 250; i++) {
    try { await health(); } catch (_) { stopped = true; break; }
    await delay(100);
  }
  assert.equal(stopped, true, 'service did not stop after its last page closed');
  const exitMs = Date.now() - started;
  assert.ok(exitMs >= 14000, 'refresh grace period was skipped');
  console.log(JSON.stringify({ version: initial.version, desktopPages: 6, multiTab: true, refresh: true, lastPageExitMs: exitMs }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const controller of streams) controller.abort();
});
