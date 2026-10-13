/**
 * report-util.js — 学习报告聚合层（纯函数，无 DOM）
 * 浏览器（report.html <script> 全局 EduReport）与 Node 单测（module.exports）双用。
 * 输入：每课程的 /api/session/:id 返回的会话信息（learning.kps / summary / memories / turnLog…）
 * 输出：课程维度统计 + 合计 + 错题本 + 复习分桶 + 记忆汇总。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./progress'));
  else root.EduReport = factory(root.EduProgress);
})(typeof self !== 'undefined' ? self : this, function (progress) {
  'use strict';
  const ui = typeof window !== 'undefined' ? window.ui : (text => text);

  const PHASE_CN = { not_started: ui("未开始"), preview: ui("预习中"), learning: ui("学习中"), reviewing: ui("复习中"), mastered: ui("已掌握") };
  const MEMORY_TYPE_CN = { preference: ui("偏好与风格"), pain: ui("卡点与易错"), fact: ui("背景与进度") };

  /** 距今天数（lastActivity ISO/ms → 整天数；无记录 → Infinity） */
  function daysSince(atIso, nowMs) {
    if (!atIso) return Infinity;
    const t = typeof atIso === 'number' ? atIso : Date.parse(atIso);
    if (!Number.isFinite(t)) return Infinity;
    return Math.floor((nowMs - t) / 86400000);
  }

  /** 单个课程会话 → 课程报告（course 可带 titleMap: {kpId: 标题}，来自 /api/course 大纲） */
  function courseReport(course, info, nowMs) {
    const kps = (info && info.learning && info.learning.kps) || {};
    const titleOf = (id) => (course.titleMap && course.titleMap[id]) || id;
    const list = Object.values(kps);
    const byPhase = {};
    const stages = { not_started: 0, preview: 0, learning: 0, reviewing: 0, mastered: 0 };
    const kpRows = [];   // 逐知识点旅程视角：阶段 + 已通过的检测 + 复习状态
    const pending = [];  // 还缺哪一步检测（严格梯级下的"下一步"）
    let quizCorrect = 0;
    let quizTotal = 0;
    const mistakes = [];
    const reviewItems = [];
    let lastActivity = null;
    for (const id of Object.keys(kps)) {
      const rec = kps[id];
      byPhase[rec.phase] = (byPhase[rec.phase] || 0) + 1;
      const phaseKey = Object.hasOwn(stages, rec.phase) ? rec.phase : 'not_started';
      stages[phaseKey] += 1;
      quizCorrect += rec.quizCorrect || 0;
      quizTotal += rec.quizTotal || 0;
      if (rec.quizHistory) {
        for (const h of rec.quizHistory) {
          if (h && h.correct === false) mistakes.push({
            courseId: course.id, courseTitle: course.title, kpId: id, kpTitle: titleOf(id),
            question: h.question, userAnswer: h.userAnswer, explanation: h.explanation, at: h.at,
          });
        }
      }
      // 检测凭据（严格梯级：预习自测 → 随堂练习 → 复习测验）
      const checks = rec.checks || {};
      const evidence = [];
      if (checks.preview) evidence.push(ui("预习自测"));
      if (checks.learn) evidence.push(ui("随堂练习"));
      if (checks.review) evidence.push(ui("复习测验"));
      const gate = progress.nextGate(rec);
      kpRows.push({
        courseId: course.id, kpId: id, title: titleOf(id),
        phase: rec.phase, phaseCn: PHASE_CN[rec.phase] || rec.phase,
        mastered: progress.isMastered(rec),
        evidence, nextNeed: gate ? gate.need : null, nextLabel: gate ? gate.label : null,
        legacy: !!rec.legacyProgress,
        quizCorrect: rec.quizCorrect || 0, quizTotal: rec.quizTotal || 0,
        reviewStatus: progress.reviewStatus(rec, nowMs), dueAt: (rec.review && rec.review.dueAt) || null,
      });
      if (gate) pending.push({ courseId: course.id, kpId: id, title: titleOf(id), need: gate.need, label: gate.label, phase: rec.phase });
      if (rec.phase !== 'not_started') {
        const d = daysSince(rec.lastActivity, nowMs);
        if (rec.lastActivity && (!lastActivity || Date.parse(rec.lastActivity) > Date.parse(lastActivity))) lastActivity = rec.lastActivity;
        reviewItems.push({ courseId: course.id, kpId: id, title: titleOf(id), phase: rec.phase, daysAgo: d,
          dueAt: rec.review?.dueAt || null, reviewStatus: progress.reviewStatus(rec, nowMs) });
      }
    }
    const mastered = list.filter(progress.isMastered).length;
    const studied = list.filter(rec => rec.phase !== 'not_started' || rec.quizTotal > 0).length;
    const assessed = list.filter(rec => rec.assessment).length;
    const total = list.length;
    return {
      courseId: course.id,
      title: course.title,
      dynamic: !!course.dynamic,
      totalKps: total,
      mastered,
      studied,
      assessed,
      percent: total ? Math.round((mastered / total) * 100) : 0,
      byPhase,
      stages,
      kpRows,
      pending,
      dueCount: reviewItems.filter((it) => it.reviewStatus === 'due').length,
      quizCorrect,
      quizTotal,
      quizRate: quizTotal ? Math.round((quizCorrect / quizTotal) * 100) : null,
      activityTurns: (info && info.turnLog ? info.turnLog.length : 0),
      lastActivity,
      lastDays: daysSince(lastActivity, nowMs),
      hasSession: !!info,
      mistakes,
      reviewItems,
      summary: (info && info.summary && info.summary.text) || null,
      memories: ((info && info.memories) || []).map((m) => ({ type: m.type, typeCn: MEMORY_TYPE_CN[m.type] || m.type, text: m.text, at: m.at })),
      createdAt: (info && info.createdAt) || null,
    };
  }

  /**
   * 汇总：courses = [{ id, title, dynamic }]，infos = { courseId: sessionInfo|null }
   * @returns 全量报告（供页面渲染 / 单测断言）
   */
  function aggregate(courses, infos, nowMs) {
    nowMs = nowMs || Date.now();
    const reports = courses.map((c) => {
      const info = infos[c.id] || null;
      return courseReport(c, info, nowMs);
    });
    // 每课程为 kp 补充标题映射（知识库标题在 course 大纲侧，不在会话里——由页面传入 titleMap 后可覆盖，
    // 此处保留 id 占位，页面渲染时再映射）
    const totals = reports.reduce((acc, r) => {
      acc.totalKps += r.totalKps;
      acc.mastered += r.mastered;
      acc.studied += r.studied;
      acc.assessed += r.assessed;
      acc.quizCorrect += r.quizCorrect;
      acc.quizTotal += r.quizTotal;
      acc.activityTurns += r.activityTurns;
      acc.activeCourses += r.hasSession && r.activityTurns > 0 ? 1 : 0;
      acc.pendingCount += r.pending.length;   // 还缺检测的知识点数
      acc.dueCount += r.dueCount;             // 到期该复习的知识点数
      for (const k of Object.keys(acc.stages)) acc.stages[k] += r.stages[k] || 0;
      return acc;
    }, { totalKps: 0, studied: 0, assessed: 0, mastered: 0, quizCorrect: 0, quizTotal: 0, activityTurns: 0, activeCourses: 0,
         stages: { not_started: 0, preview: 0, learning: 0, reviewing: 0, mastered: 0 }, pendingCount: 0, dueCount: 0 });

    // 错题本（跨课程聚合，按时间倒序取前 50）
    const mistakes = reports.flatMap((r) => r.mistakes)
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .slice(0, 50);

    // 复习到期时间与首页、Agent 共用；无计划的学习活动单列为继续学习。
    const reviewBuckets = { now: [], soon: [], due: [] };
    for (const r of reports) {
      for (const it of r.reviewItems) {
        const bucket = it.reviewStatus || 'now';
        reviewBuckets[bucket].push({ ...it, courseTitle: r.title, dynamic: r.dynamic });
      }
    }
    for (const k of Object.keys(reviewBuckets)) {
      reviewBuckets[k].sort((a, b) => {
        if (a.dueAt && b.dueAt) return Date.parse(a.dueAt) - Date.parse(b.dueAt);
        return (Number.isFinite(b.daysAgo) ? b.daysAgo : 0) - (Number.isFinite(a.daysAgo) ? a.daysAgo : 0);
      });
    }

    // 记忆汇总（跨课程：偏好/卡点/背景）
    const memories = reports.flatMap((r) => r.memories.map((m) => ({ ...m, courseId: r.courseId, courseTitle: r.title })));
    const summaries = reports.filter((r) => r.summary).map((r) => ({ courseId: r.courseId, courseTitle: r.title, text: r.summary }));

    return { courses: reports, totals, mistakes, reviewBuckets, memories, summaries, generatedAt: new Date(nowMs).toISOString() };
  }

  /** 便捷：单课程对象 → 报告（页面逐课调用后交给 aggregate 结构即可，主要供单测） */
  function quickReport(course, info, nowMs) {
    return courseReport(course, info, nowMs || Date.now());
  }

  return { aggregate, courseReport, quickReport, daysSince, PHASE_CN, MEMORY_TYPE_CN };
});
