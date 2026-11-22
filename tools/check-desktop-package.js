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
  for (const page of ['/', '/home.html', '/upload.html', '/report.html', '/coding.html', '/choice.html', '/exam.html']) {
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
  console.log(JSON.stringify({ version: initial.version, desktopPages: 7, multiTab: true, refresh: true, lastPageExitMs: exitMs }, null, 2));
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
  if (process.env.EDUPILOT_PRODUCT_PREVIEW_DIR && process.env.EDUPILOT_SMOKE_DATA) {
    throw Error('Product previews require a fresh automatically created data directory.');
  }
  const data = process.env.EDUPILOT_SMOKE_DATA ? path.resolve(process.env.EDUPILOT_SMOKE_DATA) : fs.mkdtempSync(path.join(os.tmpdir(), 'edupilot-app-'));
  const previewDir = process.env.EDUPILOT_PRODUCT_PREVIEW_DIR && !process.env.EDUPILOT_SMOKE_DATA
    ? path.resolve(process.env.EDUPILOT_PRODUCT_PREVIEW_DIR) : null;
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
    const initialLanguage = await view("localStorage.getItem('eduowl_lang')");
    const origin = await view('location.origin');
    assert.equal((await fetch(origin + '/api/health')).status, 401, 'backend does not require app token');
    const health = await view("fetch('/api/health').then(r=>r.json())");
    assert.equal(health.ok, true); assert.equal(health.desktop.enabled, false);
    assert.equal(health.version, require('../package.json').version);
    // Use the packaged application and its bundled Python, with isolated app
    // data. No model credentials or live provider requests are needed here.
    const productRequest = (route, body) => view(`fetch(${JSON.stringify(route)},${JSON.stringify(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })}).then(async response => ({status:response.status,body:await response.json()}))`);
    const diagnosticSession = 'native-release-diagnostic@python-intro';
    const homeUid = 'native-home-' + require('node:crypto').randomUUID();
    const homeRoute = '/api/learning-home?uid=' + encodeURIComponent(homeUid) + '&lang=zh';
    for (const page of ['/knowledge-graph.html', '/knowledge-graph.js', '/knowledge-graph.css', '/learning-lab.html', '/run-activity.js',
      '/home.html', '/home.js', '/home.css', '/home-share.js', '/project-qr.svg']) {
      assert.equal(await view(`fetch(${JSON.stringify(page)}).then(response=>response.status)`), 200, page);
    }
    const checkHome = async () => {
      const result = await productRequest(homeRoute);
      assert.equal(result.status, 200); assert.equal(result.body.ok, true);
      const builtin = result.body.courses.find(course => course.id === 'python-intro');
      assert.ok(builtin?.totalTopics > 0, 'packaged home has no built-in course outline');
      assert.equal(builtin.title, 'Python 编程入门');
      assert.equal(result.body.summary.studiedTopics, 0, 'new home invented study activity');
      assert.equal(result.body.summary.masteredTopics, 0, 'new home invented mastery');
      assert.equal(result.body.summary.independentChecks, 0, 'new home invented independent checks');
      return result.body;
    };
    const initialHome = await checkHome();
    assert.ok(initialHome.courses.every(course => course.source === 'builtin'), 'sharing check requires isolated app data without uploaded courses');
    assert.equal(initialHome.profile.nickname, '', 'preview identity must have no personal nickname');
    const previewNames = new Set(['home-zh.png', 'home-en.png', 'home-mobile.png', 'skill-domains-zh.png', 'learning-share-zh.png', 'learning-card-zh.png', 'learning-card-en.png', 'knowledge-graph-zh.png', 'knowledge-graph-list-zh.png']);
    const previewPath = name => {
      assert.ok(previewDir && previewNames.has(name), 'unknown product preview');
      return path.join(previewDir, name);
    };
    const originalWindow = previewDir ? await evaluate(`({size:${window}.getContentSize(),minimum:${window}.getMinimumSize()})`) : null;
    if (previewDir) fs.mkdirSync(previewDir, { recursive: true });
    const waitHome = async (lang, embedded = false) => {
      await until(async () => view(`(()=>{
        const frame=${embedded ? "document.querySelector('.feature-frame:not([hidden])')" : 'null'};
        const page=${embedded ? 'frame?.contentDocument' : 'document'};
        return page?.documentElement?.lang?.split('-')[0]===${JSON.stringify(lang)} && page.getElementById('homeShare')?.disabled===false
          && page.getElementById('homeContent')?.hidden===false${embedded ? " && document.body.dataset.activeView==='home' && document.getElementById('tutorialBtn')?.disabled===false" : ''};
      })()`));
      await view(`(async()=>{
        const frame=${embedded ? "document.querySelector('.feature-frame:not([hidden])')" : 'null'};
        await document.fonts.ready; if(frame) await frame.contentDocument.fonts.ready;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      })()`);
      if (embedded) {
        assert.equal(await view("document.getElementById('workspaceTitle').textContent"), lang === 'en' ? 'Learning home' : '学习主页');
        assert.equal(await view("(()=>{const nav=document.querySelector('.workspace-nav');return nav.scrollWidth>nav.clientWidth})()"), false, 'workspace navigation is clipped');
      }
    };
    const openHomeShare = async () => {
      await view("document.getElementById('homeShare').click()");
      await until(async () => {
        const state = await view("(()=>{const image=document.getElementById('homeShareImage'), error=document.getElementById('homeShareError');return {ready:!!image && !image.hidden && image.complete && image.naturalWidth>0,error:error && !error.hidden ? error.textContent : ''}})()");
        if (state.error) throw Error('Native learning card: ' + state.error);
        return state.ready;
      }, 30000);
    };
    const saveCard = async name => {
      const png = await view("(async()=>{const blob=await (await fetch(document.getElementById('homeShareImage').src)).blob();return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob)})})()");
      assert.ok(png.startsWith('data:image/png;base64,'));
      fs.writeFileSync(previewPath(name), Buffer.from(png.slice('data:image/png;base64,'.length), 'base64'));
    };
    const saveWindow = async (name, allowModal = false) => {
      if (!allowModal) assert.equal(await view("!!document.querySelector('.overlay:not(.hidden),dialog[open],.driver-overlay') || !!document.querySelector('.feature-frame:not([hidden])')?.contentDocument.querySelector('dialog[open]')"), false, 'product preview is obscured by a modal');
      await evaluate(`${window}.webContents.capturePage().then(image=>process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(previewPath(name))},image.toPNG()))`);
    };
    await view(`localStorage.setItem('eduowl_uid',${JSON.stringify(homeUid)})`);
    if (previewDir) await view(`localStorage.setItem(${JSON.stringify('eduowl_onboarding:v2:' + homeUid)},'seen');localStorage.setItem(${JSON.stringify('eduowl_profile_prompted:' + homeUid)},'1')`);
    try {
      await evaluate(`${window}.loadURL(${JSON.stringify(origin + '/home.html?lang=zh')})`);
      await waitHome('zh');
      assert.equal(await view("localStorage.getItem('eduowl_uid')"), homeUid);
      await openHomeShare();
      const share = await view(`(async()=>{
        const image=document.getElementById('homeShareImage');
        const blob=await (await fetch(image.src)).blob();
        const bytes=new Uint8Array(await blob.arrayBuffer());
        const data=await (await fetch(${JSON.stringify(homeRoute)})).json();
        const snapshot=window.EduHomeShare.buildSnapshot(data,{courseIds:['python-intro'],showName:false,lang:'zh'});
        return {size:blob.size,type:blob.type,signature:Array.from(bytes.slice(0,8)),width:image.naturalWidth,height:image.naturalHeight,
          projectUrl:snapshot.projectUrl,mastered:snapshot.summary.masteredTopics,skills:snapshot.skills.length,
          canDownload:!document.getElementById('homeDownload').disabled};
      })()`);
      assert.equal(share.type, 'image/png');
      assert.ok(share.size > 1000 && share.width > 0 && share.height > 0, 'learning card PNG is empty');
      assert.deepEqual(share.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(share.projectUrl, 'https://github.com/2092372408-pixel/EduPilot');
      assert.equal(share.mastered, 0); assert.equal(share.skills, 0); assert.equal(share.canDownload, true);
      if (previewDir) {
        await saveCard('learning-card-zh.png');
        await saveWindow('learning-share-zh.png', true);
        await view("document.getElementById('homeShareDialog').close()");
        await view("document.getElementById('homeSkills').scrollIntoView({block:'center'})");
        await view("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        await saveWindow('skill-domains-zh.png');
        await evaluate(`${window}.setContentSize(1360,900)`);
        for (const lang of ['zh', 'en']) {
          await evaluate(`${window}.loadURL(${JSON.stringify(origin)}+'/?view=home&lang='+${JSON.stringify(lang)})`);
          await waitHome(lang, true);
          await checkHome();
          await saveWindow('home-' + lang + '.png');
        }
        await evaluate(`${window}.loadURL(${JSON.stringify(origin + '/home.html?lang=en')})`);
        await waitHome('en');
        await openHomeShare();
        await saveCard('learning-card-en.png');
        await evaluate(`${window}.setMinimumSize(320,480);${window}.setContentSize(390,844)`);
        await evaluate(`${window}.loadURL(${JSON.stringify(origin + '/home.html?lang=zh')})`);
        await waitHome('zh');
        assert.deepEqual(await view('[innerWidth,innerHeight]'), [390, 844]);
        await saveWindow('home-mobile.png');
      }
    } finally {
      if (originalWindow) await evaluate(`${window}.setMinimumSize(...${JSON.stringify(originalWindow.minimum)});${window}.setContentSize(...${JSON.stringify(originalWindow.size)})`);
      await view(`localStorage.setItem('eduowl_uid',${JSON.stringify(initialUID)});${initialLanguage == null ? "localStorage.removeItem('eduowl_lang')" : `localStorage.setItem('eduowl_lang',${JSON.stringify(initialLanguage)})`}`);
      await evaluate(`${window}.loadURL(${JSON.stringify(origin)})`);
    }
    const issued = await productRequest('/api/learning-lab/start', {
      sessionId: diagnosticSession, familyId: 'parity', requestId: 'native-release-diagnostic-start',
    });
    assert.equal(issued.status, 200); assert.equal(issued.body.ok, true);
    const taskId = issued.body.currentTask.taskId;
    assert.ok(taskId); assert.equal(issued.body.harness.status, 'completed');
    assert.equal(issued.body.harness.budget.modelCalls, 0);
    const hint = await productRequest('/api/learning-lab/hint', {
      sessionId: diagnosticSession, taskId, requestId: 'native-release-diagnostic-hint',
    });
    assert.equal(hint.status, 200); assert.equal(hint.body.currentTask.hintsUsed, 1);
    const personalGraph = await productRequest('/api/knowledge-graph?sessionId=' + encodeURIComponent(diagnosticSession) + '&lang=zh');
    assert.equal(personalGraph.status, 200); assert.equal(personalGraph.body.ok, true);
    assert.equal(personalGraph.body.nodes.find(node => node.kind === 'course' && node.courseId === 'python-intro')?.title, 'Python 编程入门');
    assert.equal(personalGraph.body.nodes.find(node => node.kind === 'concept' && node.courseId === 'python-intro' && node.kpId === 'kp1')?.title, '变量与赋值');
    if (previewDir) {
      await evaluate(`${window}.loadURL(${JSON.stringify(origin + '/knowledge-graph.html?course=python-intro&lang=zh')})`);
      await until(async () => view("!document.getElementById('kgContent')?.hidden && document.querySelectorAll('#kgGraph .kg-node[data-kind=concept]').length > 0"), 30000);
      await view("document.querySelector('#kgGraph .kg-node[data-kind=concept]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))");
      await view("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      await saveWindow('knowledge-graph-zh.png');
      await view("document.getElementById('kgListTab').click()");
      await view("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      await saveWindow('knowledge-graph-list-zh.png');
      await evaluate(`${window}.loadURL(${JSON.stringify(origin)})`);
      await until(async () => view("document.readyState === 'complete'"));
    }
    const trace = await productRequest('/api/runs/' + issued.body.harness.runId + '?sessionId=' + encodeURIComponent(diagnosticSession));
    assert.equal(trace.status, 200);
    assert.ok(trace.body.run.events.some(event => event.type === 'business_committed'));
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
    const afterRecovery = await productRequest('/api/learning-lab?sessionId=' + encodeURIComponent(diagnosticSession));
    assert.equal(afterRecovery.body.currentTask.taskId, taskId);
    assert.equal(afterRecovery.body.currentTask.hintsUsed, 1);
    await checkHome();
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
    const afterRestart = await productRequest('/api/learning-lab?sessionId=' + encodeURIComponent(diagnosticSession));
    assert.equal(afterRestart.body.currentTask.taskId, taskId);
    assert.equal(afterRestart.body.currentTask.hintsUsed, 1);
    await checkHome();
    await quit();
    const log = fs.readFileSync(path.join(data, 'logs/service.log'), 'utf8');
    assert.doesNotMatch(log, /ELECTRON_RUN_AS_NODE is not supported|NODE_MODULE_VERSION/);
    console.log(JSON.stringify({ version: health.version, nativeWindow: true, rendererSandbox: true, authenticatedLoopback: true,
      closeToTray: true, singleInstance: true, builtInMcpReady: true, crashRecoveryMs: recoveryMs, portConflictHandled: true,
      persistedSession: true, bundledDiagnosticPython: true, personalKnowledgeGraph: true, harnessTrace: true,
      persistedDiagnosticTask: true, personalLearningHome: true, learningHomePng: true, learningHomeAfterRestart: true,
      cleanQuit: true, data }, null, 2));
  } finally {
    socket?.close();
    if (child && child.exitCode === null) child.kill();
    if (portOwner) await new Promise(resolve => portOwner.close(resolve));
  }
}
