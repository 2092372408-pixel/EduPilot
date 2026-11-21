/** Uploaded courses belong to this local installation, including its profiles.
 * Tombstones prevent late uploads and model responses from recreating a course.
 * The caller owns application-record cleanup and cancellation; file cleanup is
 * independently retryable so a partial failure is never reported as success.
 */
const registry = require('./kb/course-registry');
const { withCourseLock } = require('./kb/course-lock');
const pending = new Map();

async function deleteCourse(courseId, { cancelRuns, deleteRecords } = {}) {
  registry.assertDynamicCourseId(courseId);
  if (typeof deleteRecords !== 'function') throw new Error('删除课程需要学习记录清理回调');
  if (pending.has(courseId)) return pending.get(courseId);
  const record = registry.beginCourseDeletion(courseId);
  if (record.status === 'complete') return { ok: true, courseId, alreadyDeleted: true };
  const job = (async () => {
    try {
      if (cancelRuns) await cancelRuns(courseId);
      await deleteRecords(courseId);
      await require('./kb/upload').cleanupCourse(courseId);
      registry.markCourseDeletion(courseId, 'complete');
      return { ok: true, courseId };
    } catch (error) {
      const message = '课程已停止使用，部分记录或文件尚未清理完成。请重试清理。';
      console.warn('[course-lifecycle] 待清理:', courseId, error.code || error.message);
      try { registry.markCourseDeletion(courseId, 'pending', message); } catch (stateError) {
        console.warn('[course-lifecycle] 更新清理状态失败:', stateError.code || stateError.message);
      }
      return { ok: false, courseId, code: 'cleanup_pending', removed: true, error: message };
    }
  })().finally(() => pending.delete(courseId));
  pending.set(courseId, job);
  return job;
}

async function renameCourse(courseId, title) {
  registry.assertCourseWritable(courseId);
  const clean = String(title || '').trim();
  if (!clean || clean.length > 60) {
    const error = new Error('课程名称需为 1–60 字');
    error.code = 'invalid_title'; error.statusCode = 400;
    throw error;
  }
  return withCourseLock(courseId, () => {
    registry.assertCourseWritable(courseId);
    const result = registry.renameCourse(courseId, clean);
    if (!result) {
      const error = new Error('课程不存在');
      error.code = 'course_not_found'; error.statusCode = 404;
      throw error;
    }
    return { ok: true, courseId, title: result.title };
  });
}

function listPendingDeletions() {
  return registry.listPendingDeletions().map(row => ({
    id: row.id, title: row.title || row.id, status: row.status,
    requestedAt: row.requestedAt || null,
    message: row.error || '课程正在清理',
  }));
}

module.exports = { deleteCourse, renameCourse, listPendingDeletions };
