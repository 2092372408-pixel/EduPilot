/**
 * coding/runner.js — Python 代码沙箱运行（演示级安全）
 * ------------------------------------------------------------
 * 设计（学习场景演示级，非 docker/nsjail 强沙箱）：
 *   1. 危险操作预检（正则黑名单）：system 调用/网络/文件写/import 危险模块
 *   2. python -I 隔离模式（不加载 site-packages、不把脚本目录加 path）
 *   3. 在临时目录运行，脚本写入临时 .py
 *   4. 超时 5s → kill 进程
 *   5. stdout/stderr 各截断 10KB
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolvePython } = require('../python'); // 跨机器可移植的 Python 定位（PYTHON_BIN / venv / PATH）

// 危险模式黑名单（正则，命中即拒）——防系统级破坏，非防 LLM 逃逸
const DANGEROUS = [
  /^\s*(import|from)\s+(os|sys|subprocess|socket|shutil|requests|urllib|http\.client|ctypes|multiprocessing|signal|pickle|shelve|sqlite3|threading|ftplib|telnetlib|smtplib|webbrowser|pty|grp|pwd|resource|fcntl)\b/m,
  /os\.(system|popen|spawn|fork|kill)/,
  /subprocess\./,
  /socket\./,
  /open\s*\(\s*['"](?!['"])(?!stdin|stdout|stderr)([^'"]+)/m, // open() 打开外部文件
  /shutil\./,
  /(eval|exec)\s*\(/,
  /__import__\s*\(/,
  /globals\(\)|locals\(\)/,
  /sys\.modules/,
  /__builtins__/,
  /getattr\s*\(/,
  /open\([^)]*['"]w/,
];

function precheck(code) {
  const hits = [];
  for (const re of DANGEROUS) {
    if (re.test(code)) hits.push(re.toString());
  }
  return hits;
}

/** 找到可用的 Python 解释器（见 server/python.js：PYTHON_BIN → 项目 venv → PATH） */
const PRECHECK_PY = path.join(__dirname, 'sandbox_precheck.py'); // AST 白名单预检脚本
const MAX_OUT = 10 * 1024;   // 输出截断 10KB
const DEFAULT_TIMEOUT = 5000; // 默认超时 5s
const MAX_CODE_CHARS = 120000;

/**
 * 运行一段 Python 代码
 * @param {string} code
 * @param {object} [opts] { timeoutMs, stdin }
 * @returns {Promise<{stdout, stderr, exitCode, timeout, error, rejected?}>}
 */
function runPython(code, opts = {}) {
  return new Promise((resolve) => {
    if (String(code || '').length > MAX_CODE_CHARS) {
      resolve({ stdout: '', stderr: '', exitCode: null, timeout: false, rejected: true, error: `代码超过 ${MAX_CODE_CHARS} 字符上限` });
      return;
    }
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;

    // 危险预检（第一道：正则黑名单，快）
    const hits = precheck(code);
    if (hits.length) {
      resolve({ stdout: '', stderr: '', exitCode: null, timeout: false, rejected: true, error: '代码包含不允许的操作（文件/系统/网络等），学习沙箱已拦截' });
      return;
    }

    // 第二道：AST 白名单预检（黑名单可被 __subclasses__ 等绕过，白名单更严）
    runAstPrecheck(code).then((ast) => {
      if (!ast.ok) {
        // 区分"环境缺失"与"代码违规"：前者是可操作的能力缺口提示，后者才是安全拦截
        resolve({
          stdout: '', stderr: '', exitCode: null, timeout: false,
          rejected: !ast.unavailable,
          error: ast.reason || '代码未通过安全预检，学习沙箱已拦截',
          unavailable: !!ast.unavailable,
        });
        return;
      }
      runIsolated(code, { ...opts, timeoutMs }, resolve);
    }).catch(() => {
      resolve({ stdout: '', stderr: '', exitCode: null, timeout: false, rejected: true, error: '安全预检失败，未执行代码' });
    });
  });
}

/** AST 白名单预检（sandbox_precheck.py）：返回 { ok, reason } */
function runAstPrecheck(code) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolvePython(), ['-I', '-X', 'utf8', PRECHECK_PY], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 8000,
      });
    } catch (e) {
      resolve({ ok: false, reason: '安全预检不可用: ' + e.message });
      return;
    }
    let out = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    // 解释器缺失/无法启动：给出可操作的提示，而不是含糊的"解析失败"
    child.on('error', (e) => done({
      ok: false,
      reason: `无法启动 Python 解释器（${resolvePython()}）：${e.code === 'ENOENT' ? '未找到，请安装 Python 3 或设置 PYTHON_BIN' : e.message}。编程实践功能需要 Python 环境，其余学习功能不受影响`,
      unavailable: true,
    }));
    child.on('close', () => {
      if (settled) return;
      try {
        const r = JSON.parse(out.trim());
        done({ ok: r.ok === true, reason: r.ok ? null : (r.reason || '代码未通过安全预检') });
      } catch (_) {
        done({ ok: false, reason: '安全预检未返回有效结果（通常是没有可用的 Python 解释器；请安装 Python 3 或设置 PYTHON_BIN）', unavailable: true });
      }
    });
    try { child.stdin.write(code); child.stdin.end(); } catch (_) { done({ ok: false, reason: '安全预检写入失败' }); }
  });
}

/** 真正执行（临时目录 + -I 隔离 + 超时 + 输出截断） */
function runIsolated(code, opts, resolve) {
    const { timeoutMs, checks } = opts;
    // 临时目录 + 脚本文件
    let tmpDir = null;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edubox-'));
    } catch (e) {
      resolve({ stdout: '', stderr: '', exitCode: null, timeout: false, error: `沙箱创建失败: ${e.message}` });
      return;
    }
    const script = path.join(tmpDir, 'main.py');
    try { fs.writeFileSync(script, code, 'utf8'); } catch (e) {
      resolve({ stdout: '', stderr: '', exitCode: null, timeout: false, error: `脚本写入失败: ${e.message}` });
      return;
    }

    // -I 隔离模式会忽略 PYTHON* 环境变量，因此用 -X utf8 命令行标志强制 UTF-8 输出（防中文乱码）
    const python = resolvePython();
    const safeEnv = {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || process.env.WINDIR || '',
      WINDIR: process.env.WINDIR || process.env.SystemRoot || '',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONNOUSERSITE: '1',
      TEMP: tmpDir,
      TMP: tmpDir,
      TMPDIR: tmpDir,
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      PYTHONPATH: '',
    };
    const child = spawn(python, ['-I', '-X', 'utf8', checks ? path.join(__dirname, 'judge.py') : script], {
      cwd: tmpDir,
      env: safeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    // User programs should never wait for interactive input in the server.
    try { child.stdin.end(checks ? JSON.stringify({ code, checks }) : undefined); } catch (_) {}

    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d.toString('utf8').slice(0, MAX_OUT - stdout.length); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUT) stderr += d.toString('utf8').slice(0, MAX_OUT - stderr.length); });

    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      resolve({ stdout, stderr, exitCode: null, timeout: timedOut, error: `沙箱启动失败: ${e.message}` });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      cleanup();
      resolve({ stdout, stderr, exitCode: timedOut ? null : exitCode, timeout: timedOut, error: timedOut ? '运行超时（5 秒）' : null });
    });

    function cleanup() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}

module.exports = { runPython, resolvePython };
