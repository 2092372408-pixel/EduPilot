// Inspect the Git index (including forced additions), or an assembled package.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const policy = require('./publication-files.json');
const root = path.resolve(process.argv.find(arg => arg.startsWith('--directory='))?.slice(12) || '.');
const directoryMode = process.argv.some(arg => arg.startsWith('--directory='));
const staged = process.argv.includes('--staged');
const history = process.argv.includes('--history');
function walk(folder) {
  return fs.readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap(entry => {
    const name = folder + entry.name;
    // Bundled dependencies/runtime are third-party distribution content.
    if (['node_modules', 'runtime'].includes(name) && entry.isDirectory()) return [];
    return entry.isDirectory() ? walk(name + '/') : [name];
  });
}
const files = directoryMode ? walk('') : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = /(?:面试|答辩|简历|求职|测试报告|测试用例|验收|实测)|(?:^|\/)(?:career|test|tests|fixtures|verification|internal)(?:\/|$)|\.(?:db|db-wal|db-shm|log|bundle)$/i;
const problems = [];
const approved = file => !forbidden.test(file) && (file === '.env.example' || !/(?:^|\/)\.env(?:\.|$)/.test(file))
  && (policy.files.includes(file) || policy.directories.some(dir => file.startsWith(dir)));
if (history) {
  const paths = execFileSync('git', ['-c', 'core.quotepath=false', 'log', '--all', '--format=', '--name-only'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  for (const file of new Set(paths.split(/\r?\n/).filter(Boolean))) {
    if (!approved(file)) problems.push('Unapproved path in Git history: ' + file);
  }
}
for (const file of files) {
  if (!approved(file)) {
    problems.push('Unapproved publication path: ' + file);
    continue;
  }
  if (/\.(?:png|jpe?g|gif|ico|woff2?|pdf|docx|pptx)$/i.test(file)) continue;
  const content = staged && !directoryMode
    ? execFileSync('git', ['show', ':' + file], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    : fs.readFileSync(path.join(root, file), 'utf8');
  if (/(?:sk-[A-Za-z0-9_-]{24,}|tvly-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(content)) {
    problems.push('Possible credential in: ' + file);
  }
  if (/\.md$/i.test(file) && file !== 'AGENTS.md') {
    for (const match of content.matchAll(/(?:\]\(|src=")([^\s)"#]+)(?:#[^)"]*)?[)"]/g)) {
      if (/^(?:https?:|mailto:|#)/.test(match[1])) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (!files.includes(target)) problems.push('Unpublished documentation target: ' + file + ' -> ' + target);
    }
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else console.log('Publication allowlist, credentials and documentation links passed (' + files.length + ' files).');
