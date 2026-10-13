/* 学习旅程 / 进阶门禁 / 复习到期 的统一口径：服务端、首页、报告共用，不修改传入的记录。
 * 严格梯级：预习自测 → 学习 → 随堂练习全对 → 复习 → 复习测验全对 → 已掌握。
 * 每个知识点独立走这条链，任何一步都要拿出上一步的"检测凭据"（rec.checks）。 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.EduProgress = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ui = typeof window !== 'undefined' ? window.ui : (text => text);
  var PHASE = { NOT_STARTED: 'not_started', PREVIEW: 'preview', LEARNING: 'learning', REVIEWING: 'reviewing', MASTERED: 'mastered' };
  var CHECK_LABEL = { preview: ui("预习自测"), learn: ui("随堂练习"), review: ui("复习测验") };

  /** 掌握 = 复习测验全对（严格梯级下唯一的证据通道） */
  function isMastered(rec) {
    return !!(rec && rec.assessment && rec.assessment.passed === true && rec.assessment.mode === 'review');
  }

  /** 进阶门禁：null=可以进入目标阶段；否则返回缺哪一步检测及引导语 */
  function gateFor(rec, target) {
    if (!rec) return null;
    var c = rec.checks || {};
    if (target === PHASE.PREVIEW) return null;
    if (target === PHASE.LEARNING) {
      if (c.preview || rec.legacyProgress || (!rec.checks && [PHASE.LEARNING, PHASE.REVIEWING, PHASE.MASTERED].indexOf(rec.phase) >= 0)) return null;
      return { need: 'preview', label: CHECK_LABEL.preview, hint: ui("先做完预习自测（答完即可，不要求全对），才能进入正式学习") };
    }
    if (target === PHASE.REVIEWING) {
      if (c.learn || rec.legacyProgress || (!rec.checks && [PHASE.REVIEWING, PHASE.MASTERED].indexOf(rec.phase) >= 0)) return null;
      return { need: 'learn', label: CHECK_LABEL.learn, hint: ui("随堂练习全对之后才进入复习巩固，先把练习题做对") };
    }
    if (target === PHASE.MASTERED) {
      if (isMastered(rec)) return null;
      return { need: 'review', label: CHECK_LABEL.review, hint: ui("复习测验全对才能确认掌握") };
    }
    return null;
  }

  /** 该知识点"现在缺哪一步检测"：未过预习→preview，未过随堂→learn，未掌握→review，已掌握→null */
  function nextGate(rec) {
    if (!rec || isMastered(rec)) return null;
    var c = rec.checks || {};
    if (rec.checks && !c.preview && !rec.legacyProgress) return { need: 'preview', label: CHECK_LABEL.preview };
    if (rec.phase === PHASE.NOT_STARTED || rec.phase === PHASE.PREVIEW) {
      return c.preview ? { need: 'learn', label: CHECK_LABEL.learn } : { need: 'preview', label: CHECK_LABEL.preview };
    }
    if (!c.learn) return { need: 'learn', label: CHECK_LABEL.learn };
    return { need: 'review', label: CHECK_LABEL.review };
  }

  function reviewStatus(rec, now = Date.now()) {
    const due = Date.parse(rec && rec.review && rec.review.dueAt);
    if (!Number.isFinite(due)) return null;
    return due <= now ? 'due' : 'soon';
  }

  function dueForReview(learning, now = Date.now()) {
    return Object.entries((learning && learning.kps) || {})
      .filter(([, rec]) => reviewStatus(rec, now) === 'due')
      .map(([kpId, rec]) => ({ kpId, dueAt: rec.review.dueAt, dueDaysAgo: Math.max(0, Math.floor((now - Date.parse(rec.review.dueAt)) / 86400000)) }))
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  /** 未完成的测验（按知识点存储，可中断恢复） */
  function pendingQuizzes(learning) {
    const store = (learning && learning.quizzes) || {};
    return Object.entries(store)
      .filter(([, q]) => q && Array.isArray(q.questions) && (q.answers || []).length < q.questions.length)
      .map(([kpId, q]) => ({ kpId, mode: q.mode, title: q.title || '', answered: (q.answers || []).length, total: q.questions.length }));
  }

  function emptyProgress() {
    return { total: 0, studied: 0, assessed: 0, mastered: 0,
      stages: { not_started: 0, preview: 0, learning: 0, reviewing: 0, mastered: 0 },
      activePhase: 'not_started', current: null,
      pending: [], quizzes: [] };
  }

  function overallProgress(learning, course) {
    const result = emptyProgress();
    const kps = (learning && learning.kps) || {};
    const all = (course.chapters || []).flatMap(ch => ch.knowledgePoints || []);
    result.total = all.length;
    for (const kp of all) {
      const rec = kps[kp.id] || {};
      const phase = Object.hasOwn(result.stages, rec.phase) ? rec.phase : 'not_started';
      result.stages[phase]++;
      if (phase !== 'not_started' || rec.quizTotal > 0) result.studied++;
      if (rec.assessment) result.assessed++;
      if (isMastered(rec)) result.mastered++;
      const gate = nextGate(rec);
      if (gate) result.pending.push({ kpId: kp.id, title: kp.title, need: gate.need, label: gate.label, phase });
    }
    const pick = id => {
      const kp = all.find(k => k.id === id);
      return kp && kps[id] ? { kpId: id, title: kp.title, phase: kps[id].phase } : null;
    };
    let current = pick(learning && learning.currentKpId);
    if (current && current.phase === 'mastered') current = null;
    if (!current) {
      const open = all.find(kp => !isMastered(kps[kp.id]));
      if (open) current = pick(open.id);
    }
    result.current = current;
    result.activePhase = current ? current.phase : result.total && result.mastered === result.total ? 'mastered' : 'not_started';
    result.quizzes = pendingQuizzes(learning);
    return result;
  }

  return { isMastered, CHECK_LABEL, gateFor, nextGate, reviewStatus, dueForReview, pendingQuizzes, emptyProgress, overallProgress };
});
