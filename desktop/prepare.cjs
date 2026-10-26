const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.desktop-build/backend');
// This is generated staging content only; never clean the source or user data.
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const files = ['server', 'public', 'package.json', 'package-lock.json', 'mcp.servers.json', '.env.example', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'data/kb/index.json', 'data/kb/questions.json', 'data/kb/books/python-intro', 'data/kb/chunks/python-intro'];
for (const file of files) fs.cpSync(path.join(root, file), path.join(output, file), {
  recursive: true, filter: source => !/[/\\](?:__pycache__|node_modules)(?:[/\\]|$)|\.pyc$/.test(source),
});
const digest = createHash('sha256');
function hash(folder) { for (const name of fs.readdirSync(folder).sort()) { const file = path.join(folder, name); if (fs.statSync(file).isDirectory()) hash(file); else { digest.update(path.relative(output, file)); digest.update(fs.readFileSync(file)); } } }
// Dependencies are locked by package-lock, and not copied from the developer's tree.
for (const file of files) {
  const p = path.join(output, file);
  if (fs.statSync(p).isDirectory()) hash(p); else { digest.update(file); digest.update(fs.readFileSync(p)); }
}
fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify({ version: require('../package.json').version, digest: digest.digest('hex') }, null, 2));
execFileSync(process.execPath, [path.join(root, '.github/check-publication.cjs'), '--directory=' + output], { cwd: root, stdio: 'inherit' });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: output, stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync(process.execPath, [path.join(root, '.github/check-publication.cjs'), '--directory=' + output], { cwd: root, stdio: 'inherit' });
fs.copyFileSync(path.join(root, 'public/logo-mark.png'), path.join(__dirname, 'app/logo.png'));
if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'build-shortcut-icon.ps1'), '-Source', path.join(root, 'public/logo-mark.png'), '-Destination', path.join(root, '.desktop-build/EduPilot.ico')], { stdio: 'inherit' });
const appPackage = path.join(__dirname, 'app/package.json');
const app = JSON.parse(fs.readFileSync(appPackage)); app.version = require('../package.json').version;
fs.writeFileSync(appPackage, JSON.stringify(app, null, 2) + '\n');
console.log('Desktop backend prepared; user settings, keys, tests and learning data excluded.');
