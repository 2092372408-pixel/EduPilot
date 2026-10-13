const path = require('node:path');
const KB_ROOT = path.join(__dirname, '..', '..', 'data', 'kb');

function courseFiles(courseId, meta) {
  if (!/^[a-zA-Z0-9_-]+$/.test(courseId)) throw new Error('无效课程标识');
  if (meta?.indexVersion) {
    if (!/^[a-zA-Z0-9_-]+$/.test(meta.indexVersion)) throw new Error('无效索引版本');
    const directory = path.join(KB_ROOT, 'versions', courseId, meta.indexVersion);
    return { directory, books: path.join(directory, 'books'), chunks: path.join(directory, 'chunks') };
  }
  return { books: path.join(KB_ROOT, 'books', courseId), chunks: path.join(KB_ROOT, 'chunks', courseId) };
}

module.exports = { KB_ROOT, courseFiles };
