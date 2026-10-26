const fs = require('node:fs');
const path = require('node:path');

// Program files can be replaced on upgrade; settings and learning data never are.
function prepareWorkspace(bundle, userData) {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'release-manifest.json'), 'utf8'));
  const root = path.join(userData, 'workspace');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  // Use a real data directory: junctions between sibling Roaming directories
  // can be rejected by Windows profile protection. Preserve earlier app data.
  const previous = path.join(userData, 'learning-data');
  if (fs.existsSync(previous)) fs.cpSync(previous, data, {
    recursive: true, force: false, errorOnExist: false,
    filter: (source, target) => fs.statSync(source).isDirectory() || !fs.existsSync(target),
  });
  fs.cpSync(path.join(bundle, 'data'), data, {
    recursive: true, force: false, errorOnExist: false,
    filter: (source, target) => fs.statSync(source).isDirectory() || !fs.existsSync(target),
  });
  const settings = path.join(userData, 'settings.env');
  if (!fs.existsSync(settings)) fs.copyFileSync(path.join(bundle, '.env.example'), settings);
  const ready = path.join(root, '.ready');
  if (!fs.existsSync(ready) || fs.readFileSync(ready, 'utf8') !== manifest.digest) {
    fs.mkdirSync(root, { recursive: true });
    for (const name of ['server', 'public', 'package.json', 'mcp.servers.json', '.env.example']) {
      fs.cpSync(path.join(bundle, name), path.join(root, name), { recursive: true });
    }
    fs.writeFileSync(ready, manifest.digest);
  }
  for (const [name, target] of [['node_modules', path.join(bundle, 'node_modules')]]) {
    const link = path.join(root, name);
    if (fs.lstatSync(link, { throwIfNoEntry: false })) {
      if (path.resolve(fs.readlinkSync(link)) === path.resolve(target)) continue;
      fs.unlinkSync(link); // Remove only the old link, never its target or user data.
    }
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return { root, data, settings };
}

module.exports = { prepareWorkspace };
