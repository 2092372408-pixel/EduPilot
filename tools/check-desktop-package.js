// Runs against a newly installed, isolated package launched without opening a
// system browser. Native release jobs and local download checks use this path.
const assert = require('node:assert/strict');
if (process.argv[2] === '--native') {
  nativeCheck().catch(error => { console.error(error); process.exitCode = 1; });
} else {
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
}

// Native release smoke check. Inspector access is enabled only by this checker;
// installed apps launch without debugging ports or test-only IPC endpoints.
async function nativeCheck() {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawn } = require('node:child_process');
  const executable = path.resolve(process.argv[3]);
  const data = process.env.EDUPILOT_SMOKE_DATA ? path.resolve(process.env.EDUPILOT_SMOKE_DATA) : fs.mkdtempSync(path.join(os.tmpdir(), 'edupilot-app-'));
  fs.mkdirSync(data, { recursive: true });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const electron = "process.mainModule.require('electron')";
  const window = `${electron}.BrowserWindow.getAllWindows()[0]`;
  let child, socket, evaluate, portOwner;
  async function until(check, timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await check()) return; await pause(150); }
    throw Error('Native desktop check timed out');
  }
  async function launch() {
    let output = '';
    const env = { ...process.env, EDUPILOT_APP_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, ['--inspect=127.0.0.1:0'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.on('data', bytes => { output += bytes; });
    child.stdout.on('data', bytes => { output += bytes; });
    await until(() => {
      if (child.exitCode !== null) throw Error('Native app exited: ' + output);
      return /ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/.test(output);
    });
    socket = new WebSocket(output.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/)[0]);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let id = 0; const pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), callback = pending.get(message.id);
      if (callback) { pending.delete(message.id); callback(message); }
    });
    evaluate = expression => new Promise((resolve, reject) => {
      const request = ++id;
      pending.set(request, message => {
        if (message.error || message.result.exceptionDetails) reject(Error(JSON.stringify(message.error || message.result.exceptionDetails)));
        else resolve(message.result.result.value);
      });
      socket.send(JSON.stringify({ id: request, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    await until(async () => evaluate(`!!process.mainModule?.require`));
    await until(async () => evaluate(`${electron}.BrowserWindow.getAllWindows().some(w => w.webContents.getURL().startsWith('http://127.0.0.1:') && !w.webContents.isLoading())`));
    // Startup navigation completes before preload identity and app initialization.
    await until(async () => !!await view("localStorage.getItem('eduowl_uid')"));
  }
  const view = js => evaluate(`${window}.webContents.executeJavaScript(${JSON.stringify(js)})`);
  async function quit() {
    evaluate(`${electron}.app.quit()`).catch(() => {});
    socket.close();
    await until(() => child.exitCode !== null, 45000);
  }
  try {
    await launch();
    assert.equal(await view("typeof require"), 'undefined', 'renderer has Node access');
    assert.equal(await view("typeof window.edupilotDesktop"), 'undefined', 'product page has privileged recovery controls');
    const initialUID = await view("localStorage.getItem('eduowl_uid')");
    const origin = await view('location.origin');
    assert.equal((await fetch(origin + '/api/health')).status, 401, 'backend does not require app token');
    const health = await view("fetch('/api/health').then(r=>r.json())");
    assert.equal(health.ok, true); assert.equal(health.desktop.enabled, false);
    assert.equal(health.version, require('../package.json').version);
    await until(async () => (await view("fetch('/api/health').then(r=>r.json())")).mcp.ready >= 2, 30000);
    await view("fetch('/api/webmode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'native-release-check',webMode:'off'})}).then(r=>r.json())");
    await evaluate(`${window}.close()`);
    assert.equal(await evaluate(`${window}.isVisible()`), false);
    assert.equal((await view("fetch('/api/health').then(r=>r.json())")).ok, true);
    const secondEnv = { ...process.env, EDUPILOT_APP_DATA: data };
    delete secondEnv.ELECTRON_RUN_AS_NODE;
    const second = spawn(executable, [], { env: secondEnv, stdio: 'ignore', windowsHide: true });
    await until(async () => evaluate(`${window}.isVisible()`));
    await until(() => second.exitCode !== null);
    const backendPid = await evaluate("process._getActiveHandles().find(h=>h.constructor.name==='ChildProcess' && h.spawnargs?.includes('server/index.js'))?.pid");
    assert.ok(backendPid, 'supervised backend not found');
    const crashed = Date.now();
    process.kill(backendPid);
    await until(async () => {
      const pid = await evaluate("process._getActiveHandles().find(h=>h.constructor.name==='ChildProcess' && h.spawnargs?.includes('server/index.js'))?.pid");
      return pid && pid !== backendPid && await evaluate(`${window}.webContents.getURL().startsWith('http:') && !${window}.webContents.isLoading()`);
    });
    const recoveryMs = Date.now() - crashed;
    assert.equal((await view("fetch('/api/session/native-release-check').then(r=>r.json())")).webMode, 'off');
    if (process.env.EDUPILOT_SMOKE_SCREENSHOT) await evaluate(`${window}.webContents.capturePage().then(image=>process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(path.resolve(process.env.EDUPILOT_SMOKE_SCREENSHOT))},image.toPNG()))`);
    await quit();
    await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(2000) }));
    portOwner = require('node:http').createServer((_req, res) => res.end('other application'));
    await new Promise(resolve => portOwner.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
    await launch();
    assert.notEqual(await view('location.origin'), origin, 'app did not recover from a port conflict');
    assert.equal(await (await fetch(origin)).text(), 'other application', 'app interfered with the port owner');
    assert.equal(await view("localStorage.getItem('eduowl_uid')"), initialUID);
    assert.equal((await view("fetch('/api/session/native-release-check').then(r=>r.json())")).webMode, 'off');
    await quit();
    const log = fs.readFileSync(path.join(data, 'logs/service.log'), 'utf8');
    assert.doesNotMatch(log, /ELECTRON_RUN_AS_NODE is not supported|NODE_MODULE_VERSION/);
    console.log(JSON.stringify({ version: health.version, nativeWindow: true, rendererSandbox: true, authenticatedLoopback: true,
      closeToTray: true, singleInstance: true, builtInMcpReady: true, crashRecoveryMs: recoveryMs, portConflictHandled: true, persistedSession: true, cleanQuit: true, data }, null, 2));
  } finally {
    socket?.close();
    if (child && child.exitCode === null) child.kill();
    if (portOwner) await new Promise(resolve => portOwner.close(resolve));
  }
}
