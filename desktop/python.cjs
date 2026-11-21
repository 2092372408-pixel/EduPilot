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
const interpreter = JSON.parse(execFileSync(python, ['-I', '-X', 'utf8', '-c',
  'import sys, platform, json, sqlite3, fastembed, markitdown; print(json.dumps({"version": list(sys.version_info[:3]), "platform": sys.platform, "machine": platform.machine()}))'],
  { encoding: 'utf8', timeout: 60000 }));
const machine = interpreter.machine.toLowerCase();
if (interpreter.version.join('.') !== '3.13.13' || interpreter.platform !== process.platform
  || (process.arch === 'x64' ? !['x86_64', 'amd64'].includes(machine) : process.arch !== 'arm64' || !['arm64', 'aarch64'].includes(machine))) {
  throw Error('The portable Python runtime does not match the release target.');
}
const backend = path.join(staging, 'backend');
const run = (file, input) => execFileSync(python, ['-I', '-X', 'utf8', path.join(backend, file)], {
  input, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
});
const policy = JSON.parse(run('server/harness/engine.py', JSON.stringify({ command: 'authorize', payload: { actor: 'student', action: 'submit', scopeId: 'runtime-probe' } })));
const graph = JSON.parse(run('server/knowledge/graph.py', JSON.stringify({ command: 'build', courses: [] })));
const precheck = JSON.parse(run('server/coding/sandbox_precheck.py', 'value = sum([1, 2, 3])\n'));
const grade = run('server/coding/judge.py', JSON.stringify({ code: 'value = sum([1, 2, 3])', checks: ['value == 6'] }));
if (!policy.ok || !graph.ok || !Array.isArray(graph.nodes) || !precheck.ok || !grade.startsWith('EDUPILOT_CHECKS:1')) {
  throw Error('The bundled learning rules, graph or diagnostic Python entry point is unavailable.');
}
console.log('Bundled Python, learning rules, graph, diagnostic execution, conversion and embeddings ready.');
if (process.platform === 'darwin') execFileSync(python, ['-I', '-c',
  'from PIL import Image; import sys; Image.open(sys.argv[1]).convert("RGBA").resize((1024, 1024), Image.Resampling.LANCZOS).save(sys.argv[2])',
  path.join(root, 'public/logo-mark.png'), path.join(staging, 'EduPilot.png')], { stdio: 'inherit' });
