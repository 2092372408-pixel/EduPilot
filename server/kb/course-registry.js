/**
 * course-registry.js — 动态课程注册表（上传方案 v2 · U2）
 * ------------------------------------------------------------
 * 职责：动态课程（user-*）的注册 / 注销 / 列表 / 查询。
 * 持久化：data/courses/{courseId}.json（启动懒扫描加载进内存 Map，注册即写盘）。
 * 与内置课程的关系：内置 python-intro 由 server/data/course.js 提供，本模块只管 user-* 动态课；
 * 对外合并列表在 API 层做（GET /api/courses = 内置 + 动态）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COURSES_DIR = process.env.EDUOWL_COURSES_DIR || path.join(__dirname, '..', '..', 'data', 'courses');
const DELETED_DIR = path.join(COURSES_DIR, '.deleted');

function assertDynamicCourseId(courseId) {
  if (typeof courseId !== 'string' || !/^user-[a-zA-Z0-9_-]{1,120}$/.test(courseId)) {
    const error = new Error('无效的素材课程标识');
    error.code = 'invalid_course'; error.statusCode = 400;
    throw error;
  }
  return courseId;
}

function atomicJSON(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

/**
 * 节/章的学习状态稳定 key（基于 docId+章题+节题 hash，与章节顺序无关，
 * 追加文件/章节排序变化不会导致已学进度错位）。无小节时 sectionTitle 传 ''。
 */
function learningKey(docId, chapterTitle, sectionTitle) {
  const src = `${String(docId || '')}||${String(chapterTitle || '')}||${String(sectionTitle || '')}`;
  return 'kp' + crypto.createHash('sha1').update(src, 'utf8').digest('hex').slice(0, 10);
}

/**
 * 动态课程 → 与内置课同构的 course 视图（章节 + knowledgePoints 带稳定 id）。
 * 服务端学习状态机（createLearningState）、API /api/course、进度计算、前端渲染
 * 全部以这份视图为准 —— 保证 learning.kps 的 key 与前端拿到的 kp.id 完全一致。
 * 有小结的章 → 每个小结一个 kp；无小结的章 → 整章一个 kp。
 */
function dynamicCourseView(dyn) {
  return {
    id: dyn.id,
    title: dyn.title,
    description: dyn.description || '',
    learningReady: !!dyn.learningReady,
    lessonMode: dyn.lessonMode || 'prepared',
    chapters: (dyn.chapters || []).map((c) => {
      const sects = c.sections || [];
      const points = sects.length
        ? sects.map((s) => ({ id: learningKey(c.docId, c.title, s.title), title: s.title }))
        : [{ id: learningKey(c.docId, c.title, ''), title: c.title }];
      if (sects.length && c.chunks?.length) points.unshift({ id: learningKey(c.docId, c.title, ''), title: c.title });
      const knowledgePoints = points.map(kp => {
        const lesson = dyn.lessons?.[kp.id];
        return lesson ? { ...kp, summary: lesson.summary, keyPoints: lesson.keyPoints, example: lesson.example, pitfalls: lesson.pitfalls, sources: lesson.sources } : kp;
      });
      return { title: c.title, knowledgePoints };
    }),
  };
}

/** Remove an approved course path. Permission failures remain failures. */
function removeOrTrash(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.error('[course-registry] 清理文件失败:', error.code || error.message);
    return false;
  }
}

/** 内存注册表：courseId → meta（懒加载） */
let _map = null;
let _deletions = null;

function deletionMap() {
  if (_deletions) return _deletions;
  _deletions = new Map();
  if (!fs.existsSync(DELETED_DIR)) return _deletions;
  for (const filename of fs.readdirSync(DELETED_DIR)) {
    if (!/^user-[a-zA-Z0-9_-]{1,120}\.json$/.test(filename)) continue;
    const id = filename.slice(0, -5);
    try {
      const value = JSON.parse(fs.readFileSync(path.join(DELETED_DIR, filename), 'utf8'));
      _deletions.set(id, { ...value, id });
    } catch (_) {
      // A corrupt tombstone must never make a deleted course live again.
      _deletions.set(id, { id, status: 'pending', error: '删除记录需要重新核对' });
    }
  }
  return _deletions;
}

function getCourseDeletion(courseId) {
  const value = deletionMap().get(String(courseId));
  return value ? { ...value } : null;
}

function isCourseDeleted(courseId) { return deletionMap().has(String(courseId)); }
function isCourseDeleting(courseId) {
  const value = deletionMap().get(String(courseId));
  return !!value && value.status !== 'complete';
}

function assertCourseWritable(courseId) {
  assertDynamicCourseId(courseId);
  if (isCourseDeleted(courseId)) {
    const error = new Error('这门课程已删除或正在清理，请刷新课程列表。');
    error.code = 'course_deleted'; error.statusCode = 410;
    throw error;
  }
}

/** A durable tombstone is written before waiting for running uploads or tools. */
function beginCourseDeletion(courseId) {
  assertDynamicCourseId(courseId);
  const existing = getCourseDeletion(courseId);
  if (existing) return existing;
  const meta = ensureLoaded().get(courseId);
  if (!meta) {
    const error = new Error('课程不存在');
    error.code = 'course_not_found'; error.statusCode = 404;
    throw error;
  }
  const record = { id: courseId, title: meta.title, status: 'deleting', requestedAt: new Date().toISOString() };
  atomicJSON(path.join(DELETED_DIR, `${courseId}.json`), record);
  deletionMap().set(courseId, record);
  _map.delete(courseId);
  return { ...record };
}

function markCourseDeletion(courseId, status, error) {
  assertDynamicCourseId(courseId);
  if (!['pending', 'complete'].includes(status)) throw new Error('无效的删除状态');
  const previous = getCourseDeletion(courseId);
  if (!previous) throw new Error('缺少课程删除记录');
  const record = { ...previous, status, updatedAt: new Date().toISOString() };
  if (status === 'complete') {
    delete record.title; delete record.error;
  } else record.error = String(error || '部分文件尚未完成清理，请重试').slice(0, 300);
  atomicJSON(path.join(DELETED_DIR, `${courseId}.json`), record);
  deletionMap().set(courseId, record);
  return { ...record };
}

function listPendingDeletions() {
  return [...deletionMap().values()].filter(row => row.status !== 'complete').map(row => ({ ...row }));
}

function ensureLoaded() {
  if (_map) return _map;
  _map = new Map();
  fs.mkdirSync(COURSES_DIR, { recursive: true });
  for (const f of fs.readdirSync(COURSES_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(COURSES_DIR, f), 'utf8'));
      if (meta && /^user-[a-zA-Z0-9_-]{1,120}$/.test(meta.id) && !isCourseDeleted(meta.id)) _map.set(meta.id, meta);
    } catch (e) {
      console.error(`[course-registry] 跳过损坏注册文件 ${f}: ${e.message}`);
    }
  }
  console.log(`[course-registry] 已加载 ${_map.size} 个动态课程（${COURSES_DIR}）`);
  return _map;
}

/** 注册（覆盖写盘） */
function registerCourse(meta) {
  assertCourseWritable(meta?.id);
  const map = ensureLoaded();
  const target = path.join(COURSES_DIR, `${meta.id}.json`);
  atomicJSON(target, meta);
  map.set(meta.id, meta);
  return meta;
}

/** Unregister metadata after tombstoning. Cleanup failures remain retryable. */
function unregisterCourse(courseId) {
  beginCourseDeletion(courseId);
  const map = ensureLoaded();
  map.delete(courseId);
  const f = path.join(COURSES_DIR, `${courseId}.json`);
  if (fs.existsSync(f) && !removeOrTrash(f)) throw new Error('课程记录文件尚未完成清理');
}

/** 改名（内存 + 写盘），返回更新后的 meta */
function renameCourse(courseId, newTitle) {
  assertCourseWritable(courseId);
  const meta = getDynamicCourse(courseId);
  if (!meta) return null;
  const t = String(newTitle || '').trim().slice(0, 60);
  if (!t) return meta;
  const updated = { ...meta, title: t, updatedAt: new Date().toISOString(),
    description: `用户上传素材《${t}》（${meta.bookCount || 1} 篇 / ${meta.chapterCount || 0} 章 / ${meta.chunkCount || 0} 块内容）` };
  return registerCourse(updated);
}

/** 动态课程列表（按创建时间倒序） */
function listDynamicCourses() {
  return [...ensureLoaded().values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/** 查单个动态课程 */
function getDynamicCourse(courseId) {
  if (isCourseDeleted(courseId)) return null;
  return ensureLoaded().get(courseId) || null;
}

/** 是否为动态课程 id（user- 前缀） */
function isDynamicCourseId(courseId) {
  return String(courseId || '').startsWith('user-');
}

module.exports = {
  COURSES_DIR,
  DELETED_DIR,
  assertDynamicCourseId,
  assertCourseWritable,
  beginCourseDeletion,
  markCourseDeletion,
  getCourseDeletion,
  isCourseDeleted,
  isCourseDeleting,
  listPendingDeletions,
  registerCourse,
  unregisterCourse,
  renameCourse,
  removeOrTrash,
  listDynamicCourses,
  getDynamicCourse,
  isDynamicCourseId,
  learningKey,
  dynamicCourseView,
};
