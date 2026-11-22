'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const LOCATION_FILE = 'storage-location.json';
const PENDING_FILE = 'storage-migration.json';

function normalized(location) {
  if (typeof location !== 'string' || !path.isAbsolute(location) || location.includes('\0')) {
    throw new Error('学习数据目录必须是有效的绝对路径。');
  }
  return path.resolve(location);
}
function same(left, right) {
  const a = normalized(left), b = normalized(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function within(parent, child) {
  const relative = path.relative(normalized(parent), normalized(child));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function locationFile(defaultDirectory) { return path.join(defaultDirectory, LOCATION_FILE); }
function pendingFile(defaultDirectory) { return path.join(defaultDirectory, PENDING_FILE); }

function configuredLocation(defaultDirectory) {
  const configFile = locationFile(defaultDirectory);
  if (!fs.existsSync(configFile)) return normalized(defaultDirectory);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.version !== 1) throw new Error('学习数据目录配置版本无效。');
  return normalized(config.directory);
}

function existingLearningData(defaultDirectory) {
  return ['installation-id', 'settings.env', 'workspace', 'Local Storage', 'Preferences'].some(name =>
    fs.existsSync(path.join(defaultDirectory, name)));
}

function proposedLocation(defaultDirectory, activeDirectory, parentDirectory) {
  const target = normalized(path.join(normalized(parentDirectory), 'EduPilot-Data'));
  const origin = normalized(activeDirectory);
  if (same(target, origin)) throw new Error('新位置与当前学习数据目录相同。');
  if (within(origin, target) || within(target, origin)) throw new Error('新数据目录不能位于旧目录内部，也不能包含旧目录。');
  if (within(defaultDirectory, target)) throw new Error('新数据目录不能放在默认配置目录内部。');
  if (process.platform === 'win32' && target.startsWith('\\\\')) {
    throw new Error('建议选择本机磁盘，不支持将实时学习数据库放在网络共享路径。');
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    throw new Error('目标 EduPilot-Data 文件夹已有内容，请选择其他位置以免覆盖数据。');
  }
  return target;
}

function writeConfig(defaultDirectory, directory) {
  fs.mkdirSync(defaultDirectory, { recursive: true });
  const filename = locationFile(defaultDirectory);
  const temporary = filename + '.tmp-' + randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, directory: normalized(directory) }, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function queueLocationMove(defaultDirectory, sourceDirectory, targetDirectory) {
  const current = configuredLocation(defaultDirectory);
  if (!same(current, sourceDirectory)) throw new Error('当前学习数据目录已改变，请重新打开设置。');
  const destination = normalized(targetDirectory);
  if (same(sourceDirectory, destination) || within(sourceDirectory, destination) || within(destination, sourceDirectory)) {
    throw new Error('新数据目录不能与旧目录重叠。');
  }
  if (within(defaultDirectory, destination)) throw new Error('新数据目录不能在默认配置文件夹内部。');
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error('目标目录非空，不会覆盖已有内容。');
  fs.mkdirSync(defaultDirectory, { recursive: true });
  fs.writeFileSync(pendingFile(defaultDirectory),
    JSON.stringify({ version: 1, source: normalized(sourceDirectory), destination }, null, 2) + '\n', { flag: 'wx' });
}

function completePendingMove(defaultDirectory) {
  const pending = pendingFile(defaultDirectory);
  if (!fs.existsSync(pending)) return configuredLocation(defaultDirectory);
  const spec = JSON.parse(fs.readFileSync(pending, 'utf8'));
  if (spec.version !== 1 || !same(configuredLocation(defaultDirectory), spec.source)) {
    throw new Error('检测到不一致的数据迁移记录。原始数据没有被修改。');
  }
  const source = normalized(spec.source), destination = normalized(spec.destination);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('原始学习数据目录不可用。');
  if (same(source, destination) || within(source, destination) || within(destination, source) || within(defaultDirectory, destination)) {
    throw new Error('数据迁移路径无效。原始数据没有被修改。');
  }
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
    throw new Error('目标目录已经有数据，已停止迁移以防覆盖。');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stage = destination + '.moving-' + randomUUID();
  try {
    fs.cpSync(source, stage, {
      recursive: true, force: false, errorOnExist: true, dereference: false,
      filter: entry => {
        const relative = path.relative(source, entry).split(path.sep).join('/');
        if (relative === '') return true;
        if (fs.lstatSync(entry).isSymbolicLink()) return false;
        if ([LOCATION_FILE, PENDING_FILE, 'workspace/node_modules', 'workspace/server',
          'workspace/public', 'workspace/.ready', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache']
          .some(ignored => relative === ignored || relative.startsWith(ignored + '/'))) return false;
        return true;
      },
    });
    for (const essential of ['workspace/data/app.db', 'settings.env', 'installation-id']) {
      if (fs.existsSync(path.join(source, essential)) && !fs.existsSync(path.join(stage, essential))) {
        throw new Error('学习数据复制校验失败：' + essential);
      }
    }
    if (fs.existsSync(destination)) fs.rmdirSync(destination);
    fs.renameSync(stage, destination);
    // Only switch the selection after the complete copy has been promoted.
    // The previous directory is deliberately retained as a backup.
    writeConfig(defaultDirectory, destination);
    fs.unlinkSync(pending);
    return destination;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  configuredLocation, existingLearningData, proposedLocation,
  queueLocationMove, completePendingMove, writeConfig,
};
