/**
 * exam.js — 期末大实践（混合卷：选择题 + 代码实践题）
 * ------------------------------------------------------------------
 * 定位：整个课程的最终检验，像一张考卷。复习阶段是为它做铺垫。
 *
 * 规则（与用户确认的规格一致）：
 *  - 解锁：课程内每个知识点都通过"学习检测"（随堂练习全对，即进入复习及以上）
 *  - 出题：按个人学习情况——待巩固 / 错题多 / 到期该复习的知识点优先，之后按课程顺序补齐
 *  - 卷面：8 道选择题 + 2 道代码实践题，满分 100（选择题每题 6 分，编程题每题 26 分，按用例通过率给分）
 *  - 闭卷：开考即生成试卷快照（不可换题），限时 60 分钟；离开答题页会被记录（leftCount）
 *  - 评分：选择题机判 + 编程题在沙箱里跑测试用例；可重考，保留历史并取最高分
 */

const { getAllKnowledgePoints, findKnowledgePoint, course } = require('./data/course');
const codingProblems = require('./coding/problems');
const { gradeSubmission } = require('./coding/grader');
const { isMastered } = require('../public/progress');
const courseRegistry = require('./kb/course-registry');
const { createHash, randomUUID } = require('node:crypto');
const submissions = new WeakMap();

const RULES = {
  choiceCount: 8,
  codingCount: 2,
  minutes: 60,
  passScore: 60,
  choiceScore: 6,
  codingScore: 26,
};

/** 取会话所属课程的"章节+知识点"视图（内置课与素材课同构） */
function viewOf(session) {
  const cid = (session && session.activeCourseId) || course.id;
  if (cid === course.id) return { id: course.id, title: course.title, dynamic: false, chapters: course.chapters };
  const dyn = courseRegistry.getDynamicCourse(cid);
  if (!dyn) return null;
  return { ...courseRegistry.dynamicCourseView(dyn), dynamic: true };
}

/** 该课程的题目来源：内置课读自带题库；素材课读 quiz-gen 已生成的缓存（同步，不触发生成） */
function questionsOf(view, kpId) {
  if (!view) return [];
  if (!view.dynamic) {
    const found = findKnowledgePoint(kpId);
    return (found && found.kp.quiz) || [];
  }
  const quizGen = require('./kb/quiz-gen');
  const cached = quizGen.cachedQuiz(view.id, kpId);
  return (cached && cached.questions) || [];
}

/** 是否已通过"学习检测"（严格梯级下进入复习的前置条件） */
function checkedLearn(rec) {
  if (!rec) return false;
  if (rec.checks && rec.checks.learn) return true;
  if (rec.legacyProgress) return true;
  return !rec.checks && (rec.phase === 'reviewing' || rec.phase === 'mastered');
}

/** 解锁状态：全部知识点（内置课=知识点，素材课=小节）通过学习检测才能参加期末大实践 */
function unlockStatus(learning, view) {
  const all = ((view && view.chapters) || []).flatMap((ch) => ch.knowledgePoints || []);
  const missing = [];
  for (const kp of all) {
    const rec = (learning && learning.kps && learning.kps[kp.id]) || null;
    if (!checkedLearn(rec)) missing.push({ kpId: kp.id, title: kp.title, phase: (rec && rec.phase) || 'not_started' });
  }
  return {
    unlocked: all.length > 0 && missing.length === 0,
    total: all.length,
    passed: all.length - missing.length,
    missing,
  };
}

/** 薄弱度评分：越需要巩固的知识点越靠前（用于"按个人学习情况出题"） */
function weaknessOf(rec) {
  if (!rec) return 0;
  let w = 0;
  if (rec.phase === 'reviewing') w += 30;
  else if (rec.phase === 'learning') w += 22;
  else if (rec.phase === 'preview') w += 12;
  if (isMastered(rec)) w -= 20;
  if (rec.assessment && rec.assessment.passed === false) w += 25;
  const wrong = (rec.quizHistory || []).filter((h) => h && h.correct === false).length;
  w += Math.min(wrong * 8, 40);
  if (rec.review && Date.parse(rec.review.dueAt) <= Date.now()) w += 15;
  return w;
}

/** 组卷：知识点按薄弱度排序后取题；选择题优先取学生错过的题（素材课题目来自 quiz-gen 题库） */
function buildPaper(learning, view) {
  const ranked = ((view && view.chapters) || [])
    .flatMap((ch) => (ch.knowledgePoints || []).map((kp) => ({ kp, chapter: ch })))
    .map(({ kp, chapter }) => ({ kp, chapter, w: weaknessOf(learning && learning.kps ? learning.kps[kp.id] : null) }))
    .sort((a, b) => b.w - a.w);

  const choice = [];
  for (const { kp, chapter } of ranked) {
    if (choice.length >= RULES.choiceCount) break;
    const qs = questionsOf(view, kp.id);
    if (!qs.length) continue;
    const wrongTexts = new Set(
      (((learning && learning.kps && learning.kps[kp.id]) || {}).quizHistory || [])
        .filter((h) => h && !h.correct).map((h) => h.question)
    );
    const sorted = [...qs].sort((a, b) => (wrongTexts.has(b.q) ? 1 : 0) - (wrongTexts.has(a.q) ? 1 : 0));
    let taken = 0;
    for (const q of sorted) {
      if (taken >= 2 || choice.length >= RULES.choiceCount) break;
      choice.push({
        id: `c${choice.length + 1}`, kpId: kp.id, kpTitle: kp.title, chapter: chapter.title,
        q: q.q, options: q.options, answer: q.answer, explanation: q.explanation || '',
      });
      taken += 1;
    }
  }

  const coding = [];
  if (view && !view.dynamic) {
    for (const { kp, chapter } of ranked) {
      if (coding.length >= RULES.codingCount) break;
      const probs = codingProblems.getProblems(kp.id);
      if (!probs.length) continue;
      const p = probs[0];
      coding.push({
        id: `p${coding.length + 1}`, kpId: kp.id, kpTitle: kp.title, chapter: chapter.title,
        problemId: p.id, title: p.title, description: p.description,
        starterCode: p.starterCode || '', testCount: (p.testCases || []).length,
      });
    }
  }

  return { choice, coding };
}

/** 下发给前端的试卷（去掉答案与解析） */
function publicPaper(cur) {
  return {
    id: cur.id,
    startedAt: cur.startedAt,
    endsAt: cur.endsAt,
    minutes: RULES.minutes,
    leftCount: cur.leftCount || 0,
    choice: cur.choice.map((q) => ({ id: q.id, kpId: q.kpId, kpTitle: q.kpTitle, q: q.q, options: q.options })),
    coding: cur.coding.map((p) => ({ id: p.id, kpId: p.kpId, kpTitle: p.kpTitle, title: p.title, description: p.description, starterCode: p.starterCode, testCount: p.testCount })),
    maxScore: 100,
  };
}

/** 开始（或继续）一次期末大实践 */
function startExam(session) {
  const view = viewOf(session);
  const st = unlockStatus(session.learning, view);
  if (!st.unlocked) return { error: '尚未解锁期末大实践', unlocked: false, missing: st.missing, progress: `${st.passed}/${st.total}` };
  session.exam = session.exam || { attempts: [], current: null };
  // An expired, unsubmitted paper must not trap the learner in an unfinishable exam.
  if (session.exam.current && !submissions.has(session) && Date.now() >= Date.parse(session.exam.current.endsAt)) session.exam.current = null;
  // 已有一份未提交的试卷 → 继续（不换题，保证闭卷公平）
  if (session.exam.current && !session.exam.current.submitted) {
    return { ok: true, resumed: true, paper: publicPaper(session.exam.current), rules: RULES, attempts: (session.exam.attempts || []).length };
  }
  const paper = buildPaper(session.learning, view);
  if (!paper.choice.length && !paper.coding.length) return { error: '当前课程没有可用题目' };
  const now = Date.now();
  session.exam.current = {
    id: 'exam-' + randomUUID(),
    startedAt: new Date(now).toISOString(),
    endsAt: new Date(now + RULES.minutes * 60000).toISOString(),
    choice: paper.choice,
    coding: paper.coding,
    leftCount: 0,
    submitted: false,
  };
  return { ok: true, paper: publicPaper(session.exam.current), rules: RULES, attempts: (session.exam.attempts || []).length };
}

/** 离开答题页记录（闭卷约束：仅记录，不直接作废，避免误伤切屏看时间） */
function noteLeave(session) {
  const cur = session.exam && session.exam.current;
  if (!cur || cur.submitted) return { ok: false };
  cur.leftCount = (cur.leftCount || 0) + 1;
  return { ok: true, leftCount: cur.leftCount };
}

/** 交卷评分：选择题机判 + 编程题沙箱跑用例 */
async function submitExam(session, input = {}) {
  const cur = session.exam && session.exam.current;
  const attemptId = String(input.attemptId || '');
  if (!attemptId) return { error: '缺少试卷标识，请刷新试卷后重试' };
  const canonical = value => Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, String(val ?? '')]));
  const snapshot = { answers: canonical(input.answers), code: canonical(input.code) };
  const submissionHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const previous = (session.exam?.attempts || []).find(attempt => attempt.id === attemptId);
  if (previous) return previous.submissionHash === submissionHash ? { ...examResult(session, previous), replayed: true } : { error: '这份试卷已提交，不能修改答案' };
  const pending = submissions.get(session);
  if (pending) return pending.id === attemptId && pending.hash === submissionHash ? pending.promise : { error: '试卷正在评分，不能更换提交内容' };
  if (!cur || cur.submitted || cur.id !== attemptId) return { error: '没有进行中的考试或试卷已更换' };
  if (!Number.isFinite(Date.parse(cur.endsAt)) || Date.now() >= Date.parse(cur.endsAt)) return { error: '考试已截止，不能提交新的答案', expired: true };
  cur.status = 'grading';
  const promise = gradeExam(session, cur, snapshot, submissionHash).finally(() => {
    submissions.delete(session);
    if (session.exam.current === cur) cur.status = 'in_progress';
  });
  submissions.set(session, { id: cur.id, hash: submissionHash, promise });
  return promise;
}

async function gradeExam(session, cur, input, submissionHash) {
  const answers = input.answers || {};
  const codeMap = input.code || {};

  let choiceGot = 0;
  const detail = [];
  for (const q of cur.choice) {
    const picked = String(answers[q.id] || '').trim().toUpperCase().charAt(0);
    const ok = picked === q.answer;
    if (ok) choiceGot += 1;
    detail.push({ id: q.id, type: 'choice', kpTitle: q.kpTitle, q: q.q, picked, answer: q.answer, ok, explanation: q.explanation });
  }

  let codingRaw = 0;
  const codingDetail = [];
  for (const p of cur.coding) {
    const src = String(codeMap[p.id] || '').trim();
    if (!src) {
      codingDetail.push({ id: p.id, type: 'coding', title: p.title, kpTitle: p.kpTitle, score: 0, passed: 0, total: p.testCount, skipped: true });
      continue;
    }
    let r = null;
    try {
      r = await gradeSubmission(p.kpId, p.problemId, src);
    } catch (e) {
      r = { error: e.message };
    }
    const total = r.total || p.testCount || 1;
    const ratio = r.error ? 0 : (r.passed || 0) / total;
    codingRaw += ratio * RULES.codingScore;
    codingDetail.push({
      id: p.id, type: 'coding', title: p.title, kpTitle: p.kpTitle,
      score: Math.round(ratio * RULES.codingScore), reached: RULES.codingScore,
      passed: r.passed || 0, total, results: r.results || [], review: r.review || null, error: r.error || null,
    });
  }

  const maxScore = cur.choice.length * RULES.choiceScore + cur.coding.length * RULES.codingScore;
  const raw = choiceGot * RULES.choiceScore + codingRaw;
  const score = maxScore ? Math.round((raw / maxScore) * 100) : 0;
  const attempt = {
    id: cur.id,
    at: new Date().toISOString(),
    score,
    passed: score >= RULES.passScore,
    choice: { got: choiceGot * RULES.choiceScore, total: cur.choice.length * RULES.choiceScore },
    coding: { got: Math.round(codingRaw), total: cur.coding.length * RULES.codingScore },
    leftCount: cur.leftCount || 0,
    expired: false,
    submissionHash,
    detail: [...detail, ...codingDetail],
  };
  cur.submitted = true;
  session.exam.attempts = (session.exam.attempts || []).concat(attempt);
  session.exam.current = null;
  return examResult(session, attempt);
}

function examResult(session, attempt) {
  const best = session.exam.attempts.reduce((m, a) => (a.score > (m ? m.score : -1) ? a : m), null);
  return {
    ok: true,
    attempt,
    best: { score: best.score, at: best.at, passed: best.passed },
    attempts: session.exam.attempts.length,
    passed: attempt.passed,
    passScore: RULES.passScore,
  };
}

/** 给前端/报告用的考试成绩概览 */
function examSummary(session) {
  const ex = session.exam || {};
  const attempts = ex.attempts || [];
  const best = attempts.reduce((m, a) => (a.score > (m ? m.score : -1) ? a : m), null);
  const st = unlockStatus(session.learning, viewOf(session));
  return {
    unlocked: st.unlocked,
    progress: `${st.passed}/${st.total}`,
    missing: st.missing.slice(0, 8),
    rules: RULES,
    attempts: attempts.map((a) => ({ id: a.id, at: a.at, score: a.score, passed: a.passed, leftCount: a.leftCount, expired: a.expired })),
    best: best ? { score: best.score, at: best.at, passed: best.passed } : null,
    // 最近一次成绩单（供"回看成绩"与截图；编程题的逐条用例结果做截断）
    lastDetail: (() => {
      const last = attempts[attempts.length - 1];
      if (!last) return null;
      return {
        score: last.score, passed: last.passed, at: last.at,
        leftCount: last.leftCount, expired: last.expired,
        choice: last.choice, coding: last.coding,
        detail: (last.detail || []).map((d) => (d.type === 'coding'
          ? { ...d, results: (d.results || []).slice(0, 6) }
          : d)),
      };
    })(),
    inProgress: !!(ex.current && !ex.current.submitted),
  };
}

module.exports = { RULES, unlockStatus, buildPaper, publicPaper, startExam, noteLeave, submitExam, examSummary };
