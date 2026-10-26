const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Service extends EventEmitter {
  constructor({ executable, root, env, port, token, logFile, startupMs = 30000, healthMs = 3000 }) {
    super();
    Object.assign(this, { executable, root, env, port, token, startupMs, healthMs });
    this.origin = 'http://127.0.0.1:' + port;
    this.closed = true;
    this.state = { phase: 'starting' };
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
      fs.rmSync(logFile + '.previous', { force: true });
      fs.renameSync(logFile, logFile + '.previous');
    }
    this.log = fs.createWriteStream(logFile, { flags: 'a' });
  }
  setState(phase) {
    this.state = { phase };
    this.emit('state', this.state);
  }
  async healthy() {
    try {
      const res = await fetch(this.origin + '/api/health', {
        headers: { Authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(1500),
      });
      const body = await res.json();
      return res.ok && body.ok && body.installationId === this.env.EDUPILOT_INSTANCE_ID;
    } catch { return false; }
  }
  start() {
    if (this.running) return this.running;
    this.closed = false;
    this.running = this.run().catch(error => {
      this.log.write(error.stack + '\n'); this.setState('failed');
    }).finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    const failures = [];
    while (!this.closed) {
      this.setState(failures.length ? 'recovering' : 'starting');
      const child = spawn(this.executable, ['server/index.js'], {
        cwd: this.root, env: { ...this.env, HOST: '127.0.0.1', PORT: String(this.port), EDUPILOT_DESKTOP: '0', EDUOWL_AUTH_TOKEN: this.token },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, detached: process.platform !== 'win32',
      });
      this.child = child;
      let ended = false;
      const exited = new Promise(resolve => {
        child.once('exit', () => { ended = true; resolve(); });
        child.once('error', error => { ended = true; this.log.write(error.message + '\n'); resolve(); });
      });
      const record = bytes => this.log.write(String(bytes).split(this.token).join('[REDACTED]'));
      child.stdout.on('data', record); child.stderr.on('data', record);
      const deadline = Date.now() + this.startupMs;
      let ready = false;
      while (!this.closed && !ended && Date.now() < deadline) {
        if (await this.healthy()) { ready = true; break; }
        await Promise.race([delay(200), exited]);
      }
      if (ready && !this.closed && !ended) {
        this.setState('ready');
        let missed = 0;
        while (!this.closed && !ended) {
          await Promise.race([delay(this.healthMs), exited]);
          if (this.closed || ended) break;
          missed = await this.healthy() ? 0 : missed + 1;
          if (missed >= 3) break;
        }
      }
      if (!ended) await this.terminate(child, exited);
      // On macOS, also reap descendants if the backend itself crashed.
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
      if (this.child === child) this.child = null;
      if (this.closed) break;
      failures.push(Date.now());
      while (failures[0] < Date.now() - 60000) failures.shift();
      if (failures.length >= 3) { this.setState('failed'); return; }
      this.setState('recovering');
      await delay(failures.length * 500);
    }
  }
  async terminate(child, exited) {
    if (child.connected) child.send({ type: 'edupilot:shutdown' }, () => {});
    else child.kill('SIGTERM');
    let timeout;
    const graceful = await Promise.race([exited.then(() => true), new Promise(resolve => { timeout = setTimeout(() => resolve(false), 35000); })]);
    clearTimeout(timeout);
    if (!graceful && child.pid) {
      if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, resolve));
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      await exited;
    }
  }
  async stop() {
    this.restartPending = false;
    this.closed = true;
    if (this.child?.connected) this.child.send({ type: 'edupilot:shutdown' }, () => {});
    await this.running;
  }
  restart() {
    if (!this.restarting) {
      const stopped = this.stop();
      this.restartPending = true;
      this.restarting = stopped.then(() => { if (this.restartPending) this.start(); }).finally(() => { this.restarting = null; });
    }
    return this.restarting;
  }
}

module.exports = { Service };
