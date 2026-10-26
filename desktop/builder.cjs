const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Arch } = require('builder-util');
if (process.env.CSC_LINK === '') delete process.env.CSC_LINK;
module.exports = {
  appId: 'com.edupilot.desktop', productName: 'EduPilot',
  directories: { app: 'desktop/app', output: 'dist' },
  asar: true, npmRebuild: false,
  beforePack(context) {
    if (context.electronPlatformName !== process.platform || Arch[context.arch] !== process.arch) throw Error('Build on the target OS and architecture so bundled native dependencies match.');
    for (const file of ['backend/node_modules', process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3']) {
      if (!fs.existsSync(path.resolve(__dirname, '../.desktop-build', file))) throw Error('Run desktop:prepare and desktop:python before packaging.');
    }
    execFileSync(process.execPath, [path.resolve(__dirname, '../.github/check-publication.cjs'), '--directory=' + path.resolve(__dirname, '../.desktop-build/backend')], { stdio: 'inherit' });
  },
  files: ['**/*', '!node_modules{,/**/*}'],
  extraResources: [
    { from: '.desktop-build/backend', to: 'backend' },
    { from: '.desktop-build/backend/node_modules', to: 'backend/node_modules' },
    { from: '.desktop-build/python', to: 'python' },
  ],
  win: { target: ['nsis'], icon: path.resolve(__dirname, '../.desktop-build/EduPilot.ico'), artifactName: 'EduPilot-${version}-Windows-${arch}-Setup.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, deleteAppDataOnUninstall: false },
  mac: { target: ['dmg', 'zip'], icon: path.resolve(__dirname, '../.desktop-build/EduPilot.png'), category: 'public.app-category.education', artifactName: 'EduPilot-${version}-macOS-${arch}.${ext}',
    notarize: Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) },
  dmg: { contents: [{ x: 150, y: 190 }, { x: 430, y: 190, type: 'link', path: '/Applications' }] },
};
