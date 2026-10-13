/**
 * state.js — 学习阶段状态机
 * ------------------------------------------------------------
 * 这是教育智能体区别于通用聊天机器人的核心：
 * 每个知识点都有自己的学习阶段，智能体根据阶段提供不同的服务：
 *
 *   not_started(未开始) → preview(预习) → learning(学习中) → reviewing(复习中) → mastered(已掌握)
 *
 * 阶段推进规则（严格梯级：必须按顺序，且每步先通过检测）：
 *   - 预习           → preview      （自由进入）
 *   - 预习自测答完   → 记为 checks.preview，解锁"学习"
 *   - 学习           → learning     （需 checks.preview）
 *   - 随堂练习全对   → 记为 checks.learn，解锁"复习"
 *   - 复习           → reviewing    （需 checks.learn）
 *   - 复习测验全对   → 记为 assessment.passed，授予 mastered
 *   - 预习自测、零散练习、累计正确率都不能授予掌握；未通过检测不允许跳级
 */

// 门禁与进度口径统一放在 public/progress.js，前后端共用同一份真相
const { isMastered, emptyProgress, overallProgress, dueForReview, gateFor, nextGate, CHECK_LABEL } = require('../../public/progress');

const PHASES = {
  NOT_STARTED: 'not_started',
  PREVIEW: 'preview',
  LEARNING: 'learning',
  REVIEWING: 'reviewing',
  MASTERED: 'mastered',
};

const PHASE_LABEL = {
  not_started: '未开始',
  preview: '预习中',
  learning: '学习中',
  reviewing: '复习中',
  mastered: '已掌握',
};

const PHASE_NEXT = {
  not_started: PHASES.PREVIEW,
  preview: PHASES.LEARNING,
  learning: PHASES.REVIEWING,
  reviewing: PHASES.MASTERED,
  mastered: PHASES.MASTERED,
};

/** 创建初始学习状态（每个知识点一条记录） */
function createLearningState(course) {
  const kps = {};
  for (const ch of course.chapters) {
    for (const kp of ch.knowledgePoints) {
      kps[kp.id] = {
        phase: PHASES.NOT_STARTED,
        quizCorrect: 0,   // 累计答对题数
        quizTotal: 0,     // 累计答题数
        checks: { preview: null, learn: null, review: null }, // 各阶段检测通过时间（进阶门禁凭据）
        assessment: null, // 复习测验证据，零散练习与浏览不能授予掌握
        quizHistory: [],  // [{question, userAnswer, correct, explanation, at}]
        lastActivity: null,
      };
    }
  }
  return {
    progressVersion: 3,
    kps,
    quizzes: {},         // 进行中的测验，按知识点独立保存：{ [kpId]: {mode, questions, answers, updatedAt} }
    currentQuiz: null,   // 当前活跃测验的兼容视图（= quizzes[activeQuizKp]）
    currentQuizIndex: 0, // 当前答到第几题
    currentKpId: null,   // 当前正在学习的知识点
  };
}

/** 推进阶段：向前走一步（预习→学习→复习→已掌握），前置检测未完成则原地不动 */
function advancePhase(learning, kpId) {
  const rec = learning.kps[kpId];
  if (!rec) return;
  const next = PHASE_NEXT[rec.phase] || rec.phase;
  if (gateFor(rec, next)) return; // 未通过前置检测 → 不允许推进
  setPhase(learning, kpId, next);
  rec.lastActivity = new Date().toISOString();
}

/** 各阶段检测的名称、进阶门禁与"当前缺哪一步"统一由 public/progress.js 提供（前后端同一口径） */

/** 设置指定阶段 */
function setPhase(learning, kpId, phase) {
  const rec = learning.kps[kpId];
  if (!rec) return;
  if (!Object.values(PHASES).includes(phase) || (phase === PHASES.MASTERED && !isMastered(rec))) return;
  rec.phase = phase;
  rec.lastActivity = new Date().toISOString();
}

/**
 * 答题记录 id：错题本要按 id 精确删除某一条，而不是按"第几条"（列表顺序会随
 * 新增/过滤变化，按序号删必然删错）。进程内自增 + 时间戳 base36，足够唯一且可读。
 */
let _recordSeq = 0;
function newRecordId() {
  _recordSeq = (_recordSeq + 1) % 46656; // 36^3
  return `h${Date.now().toString(36)}${_recordSeq.toString(36)}`;
}

/** 给旧会话的历史记录补 id（幂等；错题本删除依赖 id）。返回是否有改动，需回写。 */
function ensureRecordIds(learning) {
  let changed = false;
  for (const rec of Object.values((learning && learning.kps) || {})) {
    for (const h of rec.quizHistory || []) {
      if (h && !h.id) { h.id = newRecordId(); changed = true; }
    }
  }
  return changed;
}

/**
 * 删除某知识点下指定 id 的答题记录，返回删除条数。
 * 计数同步：被删的答题不再计入累计（题目数必减，答对数仅当删的是答对记录时才减），
 * 否则"答对数/答题数"与剩余历史对不上，正确率会虚高。
 * 注意：不动 checks/assessment（梯级凭据是"当时通过"的事实，删记录不等于撤销掌握）。
 */
function removeQuizHistory(learning, kpId, ids) {
  const rec = learning && learning.kps && learning.kps[kpId];
  if (!rec || !Array.isArray(rec.quizHistory)) return 0;
  const set = new Set(ids);
  const hit = rec.quizHistory.filter((h) => h && set.has(h.id));
  if (!hit.length) return 0;
  const correctHit = hit.filter((h) => h.correct).length;
  rec.quizHistory = rec.quizHistory.filter((h) => !(h && set.has(h.id)));
  rec.quizTotal = Math.max(0, (rec.quizTotal || 0) - hit.length);
  rec.quizCorrect = Math.max(0, (rec.quizCorrect || 0) - correctHit);
  return hit.length;
}

/** 记录一次答题结果，返回累计练习正确率 */
function registerQuizResult(learning, kpId, question, userAnswer, correct, explanation) {
  const rec = learning.kps[kpId];
  if (!rec) return 0;
  rec.quizTotal += 1;
  if (correct) rec.quizCorrect += 1;
  rec.quizHistory.push({
    id: newRecordId(),
    question,
    userAnswer,
    correct,
    explanation,
    at: new Date().toISOString(),
  });
  rec.lastActivity = new Date().toISOString();
  // 注意：阶段升级不由这里触发（避免"答 1 题就掌握"的错觉），
  // 统一由 completeQuiz 按完整随堂/复习测验判定。
  if (!correct && isMastered(rec)) {
    rec.assessment = { ...rec.assessment, passed: false, invalidatedAt: rec.lastActivity };
    if (rec.checks) rec.checks.review = null; // 掌握证据被撤销，复习门禁重新关上
    rec.phase = PHASES.REVIEWING;
    reviewStep(rec, false);
  }
  return computeMastery(rec);
}

/**
 * 完整测验收尾（严格梯级，必须答完全部题目才判定）：
 *   preview 答完 → 记 checks.preview（只解锁"学习"，不授予任何掌握）
 *   learn 全对   → 记 checks.learn，进入 reviewing（没全对则留在 learning 重练）
 *   review 全对  → 写 assessment.passed，授予 mastered（否则回落 reviewing）
 */
function completeQuiz(learning, quiz) {
  if (!quiz || !Array.isArray(quiz.questions) || !quiz.questions.length) return;
  if (!Array.isArray(quiz.answers) || quiz.answers.length !== quiz.questions.length) return;
  const rec = learning.kps[quiz.kpId];
  if (!rec) return;
  if (!rec.checks) rec.checks = { preview: null, learn: null, review: null };
  const at = new Date().toISOString();
  const correct = quiz.answers.filter((v) => v === true).length;
  const allCorrect = correct === quiz.questions.length;

  if (quiz.mode === 'preview') {
    rec.checks.preview = rec.checks.preview || at;
    if (rec.phase === PHASES.NOT_STARTED) rec.phase = PHASES.PREVIEW;
    return;
  }
  if (quiz.mode === 'learn') {
    if (allCorrect) {
      rec.checks.learn = rec.checks.learn || at;
      if (rec.phase !== PHASES.MASTERED) rec.phase = PHASES.REVIEWING;
    } else if (rec.phase !== PHASES.MASTERED) {
      rec.phase = PHASES.LEARNING;
    }
    return;
  }
  // review：唯一能授予掌握的通道
  rec.assessment = { passed: allCorrect, mode: 'review', correct, total: quiz.questions.length, at };
  if (allCorrect) rec.checks.review = at;
  rec.phase = allCorrect ? PHASES.MASTERED : PHASES.REVIEWING;
  reviewStep(rec, allCorrect);
}

/**
 * 迁移旧口径到 v3（幂等）：补齐 checks/quizzes，并把"非复习测验"的掌握降级为复习中。
 * 严格梯级下，只有复习测验全对才算掌握——旧版"随堂练习全对即掌握"的记录会转成学习检测凭据。
 * 原始值一律存进 legacyProgress，不销毁历史数据。
 */
function upgradeLearningState(learning, dynamic) {
  if (!learning || learning.progressVersion >= 3) return false;
  for (const [kpId, rec] of Object.entries(learning.kps || {})) {
    rec.checks = rec.checks || { preview: null, learn: null, review: null };
    rec.assessment = rec.assessment || null;
    const a = rec.assessment;
    const validReview = !dynamic && a && a.passed === true && a.mode === 'review';
    // ① 旧版随堂练习/无模式证据 → 转为学习检测凭据（不再等于掌握）
    if (!dynamic && a && a.passed === true && a.mode !== 'review') {
      rec.checks.learn = rec.checks.learn || a.at || rec.lastActivity || null;
    }
    // ② 旧 mastered 但没有有效复习证据 → 降级为复习中，原始值留档
    if (rec.phase === PHASES.MASTERED && !validReview) {
      rec.legacyProgress = {
        phase: rec.phase, quizCorrect: rec.quizCorrect, quizTotal: rec.quizTotal,
        review: rec.review || null, assessment: a,
      };
      rec.phase = dynamic ? PHASES.LEARNING : PHASES.REVIEWING;
      rec.assessment = null;
      rec.review = null;
    }
    // ③ 有效复习证据 → 补全前置检测凭据（此前的阶段确实走过了）
    if (validReview) {
      rec.checks.review = rec.checks.review || a.at || rec.lastActivity || null;
      rec.checks.learn = rec.checks.learn || a.at || null;
      rec.checks.preview = rec.checks.preview || a.at || null;
    }
    // ④ 更老的版本：有多轮完整测验但未落 assessment 的 → 按模式转成对应检测凭据
    const cq = learning.currentQuiz;
    if (!dynamic && cq && cq.kpId === kpId && Array.isArray(cq.questions) && Array.isArray(cq.answers)
        && cq.questions.length && cq.answers.length === cq.questions.length) {
      const at = rec.lastActivity || new Date().toISOString();
      const allCorrect = cq.answers.every(Boolean);
      if (cq.mode === 'preview') rec.checks.preview = rec.checks.preview || at;
      if (cq.mode === 'learn' && allCorrect) rec.checks.learn = rec.checks.learn || at;
      if (cq.mode === 'review' && allCorrect) {
        rec.checks.preview = rec.checks.preview || at;
        rec.checks.learn = rec.checks.learn || at;
        rec.checks.review = rec.checks.review || at;
        rec.assessment = { passed: true, mode: 'review', correct: cq.answers.filter(Boolean).length, total: cq.questions.length, at };
        rec.phase = PHASES.MASTERED;
      }
    }
    // ⑤ 检索产生的虚拟成绩（素材课）清零
    const fakeQuiz = dynamic && rec.hitCount > 0 && rec.quizTotal === 2 && !(rec.quizHistory && rec.quizHistory.length);
    if (fakeQuiz) { rec.quizTotal = 0; rec.quizCorrect = 0; }
    if (!rec.assessment) rec.review = null;
  }

  // ⑥ 进行中的测验：单轮 currentQuiz → 按知识点存储
  if (!learning.quizzes || typeof learning.quizzes !== 'object') learning.quizzes = {};
  const q = learning.currentQuiz;
  if (q && q.kpId && !learning.quizzes[q.kpId]) {
    learning.quizzes[q.kpId] = {
      kpId: q.kpId, mode: q.mode, title: q.title || '', questions: q.questions || [],
      answers: q.answers || [], updatedAt: new Date().toISOString(),
    };
    learning.currentQuiz = learning.quizzes[q.kpId]; // 同一引用：答题推进直接落库
  }
  if (!learning.currentQuiz && Object.keys(learning.quizzes).length === 1) {
    const kpId = Object.keys(learning.quizzes)[0];
    learning.currentQuiz = learning.quizzes[kpId];
  }
  if (!Number.isFinite(learning.currentQuizIndex)) learning.currentQuizIndex = 0;
  if (!learning.currentKpId) learning.currentKpId = null;

  learning.progressVersion = 3;
  return true;
}

/** 累计练习正确率（保留 computeMastery 名称以兼容既有 API，不作为掌握判据） */
function computeMastery(rec) {
  if (!rec.quizTotal) return 0;
  return rec.quizCorrect / rec.quizTotal;
}

/**
 * 教学三阶段（学生的教师角色，而非可量化的刻度）：
 *   🔎 预习 = 抛砖引玉（给问题与知识地图，不揭晓结论）
 *   📖 学习 = 教授知识（类比→原理→示例→误区→追问）
 *   🔁 复习 = 巩固知识（先回忆自测，再重练错题，最后串联）
 * 因此进度不折算百分比：只如实反映"每个知识点处在哪一阶段"，
 * 以及"此刻老师正在带学生做哪一步"。
 */
const STAGE_TEACHING = {
  [PHASES.PREVIEW]: { emoji: '🔎', label: '预习', teacher: '抛砖引玉：先给问题和知识地图，让学生自己想一想' },
  [PHASES.LEARNING]: { emoji: '📖', label: '学习', teacher: '教授知识：类比→原理→示例→常见误区，讲透一个点' },
  [PHASES.REVIEWING]: { emoji: '🔁', label: '复习', teacher: '巩固知识：先回忆自测，再重练错题，最后串起来' },
  [PHASES.MASTERED]: { emoji: '🎉', label: '已掌握', teacher: '按节奏回来复习，别让记忆溜走' },
  [PHASES.NOT_STARTED]: { emoji: '🗺️', label: '未开始', teacher: '从第一章挑一个知识点，老师带你预习' },
};

/* ============ 艾宾浩斯复习调度（简化固定间隔，融入 learning.kps[].review）============
 * 规则（可预期、与 FSRS 思想同向）：
 * - 完成完整测验的知识点参与调度，进入复习阶段仍保留计划；
 * - 完成到期测验且全对→ 到期间隔按 1 → 3 → 7 → 14 → 30 天推进；
 * - 答错 → 重置为 1 天后；
 * - 到期项由 dueForReview 汇总（前端"待复习"徽标 / 报告 / Agent 提醒共用）。
 */
const REVIEW_STEPS = [1, 3, 7, 14, 30]; // 天数
const DAY_MS = 86400000;

/** 复习一步：pass=完整测验是否通过；未到期的成功不延长间隔。返回更新后的 review 或 null */
function reviewStep(rec, pass) {
  if (!rec) return null;
  if (!rec.assessment) { rec.review = null; return null; }
  const now = Date.now();
  const cur = (rec.review && rec.review.intervalDays) || 0;
  const rv = { intervalDays: 0, dueAt: null, lastReviewAt: null };
  if (pass) {
    if (rec.review && Date.parse(rec.review.dueAt) > now) return rec.review;
    rv.intervalDays = REVIEW_STEPS.find((s) => s > cur) || REVIEW_STEPS[REVIEW_STEPS.length - 1];
  } else {
    rv.intervalDays = 1; // 答错 → 重新巩固
  }
  rv.dueAt = new Date(now + rv.intervalDays * DAY_MS).toISOString();
  rv.lastReviewAt = new Date(now).toISOString();
  rec.review = rv;
  return rv;
}

/** 待复习徽标文案：如 "🔁 待复习 2"；无到期项返回 '' */
function dueBadgeText(learning, nowMs) {
  const due = dueForReview(learning, nowMs);
  return due.length ? `待复习 ${due.length}` : '';
}

module.exports = {
  completeQuiz, upgradeLearningState, isMastered,
  PHASES,
  PHASE_LABEL,
  CHECK_LABEL,
  STAGE_TEACHING,
  gateFor,
  nextGate,
  emptyProgress,
  createLearningState,
  advancePhase,
  setPhase,
  registerQuizResult,
  computeMastery,
  overallProgress,
  reviewStep,
  dueForReview,
  dueBadgeText,
  newRecordId,
  ensureRecordIds,
  removeQuizHistory,
};
