/**
 * python.js — Python 解释器定位（跨机器可移植）
 * ------------------------------------------------------------
 * 之前 coding/runner.js 与 kb/convert.js 各自硬编码了一个开发者本机的绝对路径
 * （C:/Users/<某人>/.workbuddy/.../python.exe），换机器必然失效。这里统一成：
 *
 *   1) 环境变量 PYTHON_BIN（显式指定，最高优先级）
 *   2) 项目内 venv：.venv-upload/Scripts/python.exe（Windows）/ .venv-upload/bin/python（*nix）
 *   3) PATH 上的 python3 / python（实测可执行才采用）
 *   4) 兜底 'python'（真正运行时若不存在，由 spawn 给出清晰错误）
 *
 * 结果做进程内缓存；`--version` 探测用同步 spawn（仅首次，约几十毫秒）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENV_CANDIDATES = [
  process.env.VIRTUAL_ENV && path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe'),
  process.env.VIRTUAL_ENV && path.join(process.env.VIRTUAL_ENV, 'bin', 'python'),
  path.join(ROOT, '.venv-upload', 'Scripts', 'python.exe'), // Windows venv
  path.join(ROOT, '.venv-upload', 'bin', 'python'),         // Linux/macOS venv
].filter(Boolean);

let cached = null;

/** 是否是可执行文件（绝对路径）/ 探测命令是否可用 */
function works(cmd) {
  if (path.isAbsolute(cmd)) {
    try { if (!fs.existsSync(cmd)) return false; } catch (_) { return false; }
  }
  try {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return !r.error && r.status === 0;
  } catch (_) {
    return false;
  }
}

/** 解析可用的 Python 命令（缓存） */
function resolvePython() {
  if (cached) return cached;
  const explicit = process.env.PYTHON_BIN || process.env.EDUOWL_PYTHON;
  // 显式指定（PYTHON_BIN）必须被尊重：即使它不可用也直接返回，
  // 让错误信息指向用户指定的解释器，而不是静默改用别的 Python ——
  // 否则"设了 PYTHON_BIN 却没生效"会让人极难排查（此前正是如此）。
  if (explicit) { cached = explicit; return cached; }
  const candidates = [
    ...VENV_CANDIDATES,
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    if (works(c)) { cached = c; return c; }
  }
  cached = 'python'; // 兜底：运行时报错信息会指出解释器缺失
  return cached;
}

module.exports = { resolvePython, VENV_CANDIDATES };
