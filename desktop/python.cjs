// Run on the target platform/architecture, with uv 0.11.15 available on PATH.
// The standalone interpreter is relocatable; no developer venv is distributed.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const staging = path.join(root, '.desktop-build');
const downloads = path.join(staging, 'python-runtime');
const destination = path.join(staging, 'python');
const uv = process.env.UV_BIN || 'uv';
execFileSync(uv, ['python', 'install', '3.13.13', '--install-dir', downloads, '--no-bin', '--no-registry'], { stdio: 'inherit' });
const source = fs.readdirSync(downloads).find(name => name.startsWith('cpython-3.13.13-'));
if (!source) throw Error('Standalone Python installation is missing');
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(path.join(downloads, source), destination, { recursive: true, verbatimSymlinks: true });
const python = path.join(destination, process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const packages = path.join(destination, process.platform === 'win32' ? 'Lib/site-packages' : 'lib/python3.13/site-packages');
const requirements = path.join(staging, 'python-requirements.txt');
execFileSync(uv, ['export', '--project', __dirname, '--locked', '--python', python, '--no-dev', '--no-emit-project', '--output-file', requirements, '--quiet'], { stdio: 'inherit' });
execFileSync(uv, ['pip', 'install', '--python', python, '--target', packages, '--only-binary=:all:', '--link-mode', 'copy', '--require-hashes', '-r', requirements], { stdio: 'inherit' });
execFileSync(python, ['-I', '-c', 'import sqlite3, fastembed, markitdown; print("Bundled Python, document conversion and embeddings ready")'], { stdio: 'inherit' });
