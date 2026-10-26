const { app, BrowserWindow, Menu, Tray, nativeImage, session, shell, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { prepareWorkspace } = require('./workspace.cjs');
const { Service } = require('./service.cjs');

if (process.env.EDUPILOT_APP_DATA) app.setPath('userData', path.resolve(process.env.EDUPILOT_APP_DATA));
let mainWindow, tray, service, quitting = false;
const pages = new Map();
const statusFile = path.join(__dirname, 'status.html');
const statusURL = pathToFileURL(statusFile).href;
const preferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true };
const ownsURL = url => { try { return new URL(url).origin === service?.origin; } catch { return false; } };

function showWindow() {
  if (mainWindow?.isDestroyed()) mainWindow = null;
  if (!mainWindow) {
    mainWindow = new BrowserWindow({ width: 1360, height: 900, minWidth: 850, minHeight: 620, title: 'EduPilot', backgroundColor: '#f7f7f8', icon: path.join(__dirname, 'logo.png'), webPreferences: preferences });
    mainWindow.loadURL(service?.state.phase === 'ready' ? service.origin : statusURL);
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

function secureWindow(window) {
  pages.set(window, service?.origin);
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.on('closed', () => pages.delete(window));
  window.webContents.on('will-navigate', (event, url) => {
    if (ownsURL(url) || url === statusURL) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (ownsURL(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1200, height: 850, webPreferences: preferences } };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('render-process-gone', () => {
    if (!quitting) window.loadURL(service.state.phase === 'ready' ? pages.get(window) || service.origin : statusURL);
  });
}

function reflectState(state) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    if (state.phase === 'ready') {
      window.setProgressBar(-1);
      window.loadURL(pages.get(window) || service.origin);
    } else {
      const current = window.webContents.getURL();
      if (ownsURL(current)) pages.set(window, current);
      window.setProgressBar(state.phase === 'failed' ? -1 : 2);
      if (current !== statusURL) window.loadFile(statusFile);
      else window.webContents.send('desktop:state', state);
    }
  }
}

async function portFor(userData) {
  const file = path.join(userData, 'port.json');
  if (fs.existsSync(file)) {
    const port = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(port) && port > 1023 && port < 65536) {
      const available = await new Promise(resolve => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
      });
      if (available) return port;
    }
  }
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  fs.writeFileSync(file, JSON.stringify(port));
  return port;
}

async function start() {
  const userData = app.getPath('userData');
  const bundle = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '../../.desktop-build/backend');
  const workspace = prepareWorkspace(bundle, userData);
  const instance = path.join(userData, 'installation-id');
  if (!fs.existsSync(instance)) fs.writeFileSync(instance, randomUUID());
  const token = randomUUID() + randomUUID();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', EDUOWL_ENV_FILE: workspace.settings,
    EDUOWL_DB: path.join(workspace.data, 'app.db'), EDUPILOT_INSTANCE_FILE: instance,
    EDUPILOT_INSTANCE_ID: fs.readFileSync(instance, 'utf8').trim() };
  // Do not inherit developer credentials or a database override into the app.
  for (const key of Object.keys(env)) if (/^LLM_|^(?:TAVILY_API_KEY|GITHUB_TOKEN|DASHSCOPE_API_KEY|SILICONFLOW_API_KEY)$/.test(key)) delete env[key];
  const pythonRoot = app.isPackaged ? path.join(process.resourcesPath, 'python') : path.resolve(__dirname, '../../.desktop-build/python');
  const python = process.platform === 'win32' ? path.join(pythonRoot, 'python.exe') : path.join(pythonRoot, 'bin/python3');
  if (fs.existsSync(python)) env.PYTHON_BIN = python;
  service = new Service({ executable: process.execPath, root: workspace.root, env, port: await portFor(userData), token, logFile: path.join(userData, 'logs/service.log') });
  preferences.additionalArguments = ['--edupilot-origin=' + service.origin, '--edupilot-uid=desktop-' + env.EDUPILOT_INSTANCE_ID];
  const browserSession = session.defaultSession;
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (ownsURL(details.url)) details.requestHeaders.Authorization = 'Bearer ' + token;
    callback({ requestHeaders: details.requestHeaders });
  });
  browserSession.setPermissionRequestHandler((contents, permission, callback) => {
    if (!ownsURL(contents.getURL()) || permission !== 'media') { callback(false); return; }
    dialog.showMessageBox({ type: 'question', title: 'EduPilot', message: '允许使用麦克风进行语音输入？', buttons: ['允许', '取消'], defaultId: 1, cancelId: 1 }).then(result => callback(result.response === 0));
  });
  for (const [channel, action] of Object.entries({ state: () => service.state, retry: () => { service.restart(); }, logs: () => shell.openPath(path.join(userData, 'logs')) })) {
    ipcMain.handle('desktop:' + channel, event => {
      if (event.sender.getURL() !== statusURL) throw Error('Desktop controls are only available on the recovery page');
      return action();
    });
  }
  const image = nativeImage.createFromPath(path.join(__dirname, 'logo.png')).resize({ width: 20, height: 20 });
  if (process.platform === 'darwin') image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('EduPilot · AI 学习向导');
  tray.on('click', showWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 EduPilot', click: showWindow },
    { label: '重新连接', click: () => service.restart() },
    { label: '打开学习数据文件夹', click: () => shell.openPath(workspace.data) },
    { type: 'separator' }, { label: '退出 EduPilot', click: () => app.quit() },
  ]));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'EduPilot', submenu: [{ label: '显示工作台', click: showWindow }, { label: '重新连接', click: () => service.restart() }, { type: 'separator' }, { role: 'quit', label: '退出 EduPilot' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
  showWindow();
  service.on('state', reflectState);
  service.start().catch(error => { service.log.write(error.stack + '\n'); reflectState({ phase: 'failed' }); });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (service) showWindow(); });
  app.on('browser-window-created', (_event, window) => secureWindow(window));
  app.on('activate', () => { if (service) showWindow(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    service?.stop().finally(() => { tray?.destroy(); app.quit(); });
    if (!service) app.quit();
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('EduPilot 无法启动', error.message);
    app.quit();
  });
}
