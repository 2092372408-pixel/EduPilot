const pending = new Map();

function withCourseLock(courseId, operation) {
  const next = (pending.get(courseId) || Promise.resolve()).then(operation, operation);
  const tail = next.catch(() => {});
  pending.set(courseId, tail);
  tail.finally(() => { if (pending.get(courseId) === tail) pending.delete(courseId); });
  return next;
}

module.exports = { withCourseLock };
