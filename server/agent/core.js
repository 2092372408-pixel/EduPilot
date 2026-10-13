/**
 * core.js — Agent 核心（智能体的"骨架"）
 * ------------------------------------------------------------
 * 一个最小可用的 Agent 循环：
 *
 *   用户消息
 *     → 1. 意图识别（router：把自然语言映射为结构化意图）
 *     → 2. 工具执行（tools：获取知识、出题、判分、推进状态）
 *     → 3. LLM 生成（llm：mock 或真实 API 生成教学回复）
 *     → 4. 记忆更新（memory：消息历史 + 学习状态写入 session）
 *     → 5. 返回响应（含调试信息，方便你观察 Agent 内部发生了什么）
 *
 * 会话（session）即"记忆"：messages（对话历史）+ learning（学习状态）。
 * 生产环境应把 session 持久化到 Redis / 数据库，这里用内存 Map 便于学习。
 */

const { course, findKnowledgePoint, getAllKnowledgePoints } = require('../data/course');
const courseRegistry = require('../kb/course-registry');
const { createLearningState, PHASES, PHASE_LABEL, computeMastery, overallProgress, emptyProgress, registerQuizResult, upgradeLearningState, nextGate, isMastered, completeQuiz, ensureRecordIds, removeQuizHistory } = require('./state');
const { estimateMastery, weaknessScore } = require('./mastery'); // 掌握度估计（个性化用，不参与门禁）
const { tools, WEB_SIGNAL, isMetaQuestion, fallbackKpId, activeQuizOf } = require('./tools');
const scopeEngine = require('./scope'); // 课程边界闸门（联网只服务课程/编程领域）
const { AGENTS, routeIntent, toolsForAgent } = require('./agents');
const mcpBridge = require('../mcp/bridge'); // MCP 工具来源（联网检索统一走 MCP）
const groundingEngine = require('./grounding'); // 答案忠实度校验（只标注，不阻断）
const usageEngine = require('./usage'); // token/成本核算（AsyncLocalStorage 按会话归集）
const llm = require('./llm');
const graphEngine = require('../graph/agent');
const codingProblems = require('../coding/problems');
const memoryEngine = require('./memory'); // 记忆引擎（会话总结/卡点/语义记忆）
const sessionStore = require('../store/sessionStore');
const attachmentStore = require('../store/attachmentStore');
const { wrapUntrusted } = require('./sanitize');
const logger = require('../store/logger');
const locale = require('../locale');
const webConfig = require('./webconfig');

/** 引擎选择：默认 LangGraph（supervisor 图，原生 function calling）；
 *  显式设置 ENGINE=legacy 时回退到自研 ReAct 文本协议。两条引擎共享同一套工具/状态/知识库。 */
const USE_GRAPH = process.env.ENGINE !== 'legacy';

/** 会话存储：SQLite 持久化（Step C）——启动全量加载进内存，每轮结束后写回 */
const sessions = sessionStore.loadAll();
console.log(`[store] 已加载 ${sessions.size} 个持久化会话（${sessionStore.DB_PATH}）`);

const MAX_HISTORY = 20; // 保留最近 N 条消息，防止上下文无限膨胀

/**
 * 把聊天附件转换成当前请求的模型输入。
 * 会话只保存 refs，图片 base64 和文档正文都不进入 session JSON/长期记忆。
 */
function prepareAttachments(sessionId, userMessage, attachmentIds) {
  const ids = (Array.isArray(attachmentIds) ? attachmentIds : [])
    .map((item) => typeof item === 'object' ? item && item.id : item)
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (!ids.length) return { refs: [], userContent: null, attachmentContext: '' };
  if (ids.length > 8) throw new Error('单条消息最多附加 8 个文件');
  const rows = attachmentStore.getForSession(sessionId, ids);
  if (rows.length !== new Set(ids).size) throw new Error('附件不存在或不属于当前会话，请重新上传');
  const images = rows.filter((row) => row.kind === 'image');
  if (images.length && (llm.detectMode() !== 'api' || !llm.supportsVision())) {
    const cap = llm.visionCapability();
    const model = process.env.LLM_MODEL || '当前模型';
    throw new Error(llm.detectMode() !== 'api'
      ? '当前处于离线演示模式，请先在设置中选择支持图片输入的模型'
      : cap.vision === false
      ? `当前模型「${model}」不支持图片输入，请在设置中选择支持图片输入的模型后重试`
      : `当前模型「${model}」的图片能力尚未确认，请先在设置中点击“测试图片能力”`);
  }
  const refs = rows.map((row) => attachmentStore.metadata(row));
  const imageParts = images.map((row) => attachmentStore.toContentPart(row));
  if (imageParts.some((part) => !part)) throw new Error('图片文件已丢失，请重新上传');
  const documents = rows.filter((row) => row.kind === 'document');
  let documentBudget = 12000;
  const documentBlocks = [];
  for (const row of documents) {
    if (documentBudget <= 0) break;
    const block = wrapUntrusted(
      `用户上传文件：${row.original_name}`,
      row.extracted_text || '',
      { maxChars: documentBudget },
    ).block;
    documentBlocks.push(block);
    documentBudget -= block.length;
  }
  const attachmentContext = documentBlocks.join('\n\n');
  const text = userMessage || (images.length ? '请分析我上传的图片，并结合图片内容回答。' : '请阅读我上传的文件并回答。');
  const userContent = imageParts.length
    ? [{ type: 'text', text }, ...imageParts]
    : null;
  return { refs, userContent, attachmentContext };
}
/** 动态课节级阶段顺序（用于只升不降，与内置课 tools.PHASE_ORDER 同口径） */
const DYNAMIC_PHASE_ORDER = { not_started: 0, preview: 1, learning: 2, reviewing: 3, mastered: 4 };

/**
 * 解析课程维度会话 id：`{uid}@{courseKey}`（如 demo-abc@python-intro / demo-abc@user-172…）
 * 每个课程一个独立会话 → 对话框历史 / 学习进度 / 记忆（summary/memories/painPoints）天然隔离。
 * 旧格式（无 @ 后缀，历史 demo-xxx 会话）视为 python-intro，向后兼容。
 */
function parseSessionCourseKey(sessionId) {
  const at = String(sessionId || '').lastIndexOf('@');
  if (at < 1) return course.id; // 兼容旧会话
  const key = sessionId.slice(at + 1);
  if (key === course.id) return key;
  if (courseRegistry.isDynamicCourseId(key) && courseRegistry.getDynamicCourse(key)) return key;
  return course.id; // 未知课程 key → 回退内置
}

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    const courseKey = parseSessionCourseKey(sessionId);
    const session = {
      id: sessionId,
      activeCourseId: courseKey,                  // 会话绑定的课程（解析自 id 或显式切换）
      messages: [],                               // 对话历史（记忆）——按课程独立
      learning: buildLearningForCourse(courseKey), // 内置=完整状态机；动态=节级状态机（学习进度）
      webMode: 'auto',                            // 联网模式（首页可选）：off 不联网 / on 一定联网 / auto 自动
      turnLog: [],                                // 每轮 Agent 内部轨迹（调试用）
      createdAt: new Date().toISOString(),
    };
    sessions.set(sessionId, session);
    sessionStore.save(session); // 新建即落盘（重启后能列出）
  }
  const session = sessions.get(sessionId);
  ensureLearningUpgraded(session); // 存量会话惰性升级（旧空壳 → 动态课节级状态机）
  return session;
}

/** 按课程构建学习状态：内置课 = 完整知识点状态机；动态课 = 节级状态机（章/节 = 可学单元） */
function buildLearningForCourse(courseKey) {
  if (courseKey === course.id) return createLearningState(course);
  const dyn = courseRegistry.getDynamicCourse(courseKey);
  if (!dyn) return createLearningState(course);
  return createLearningState(courseRegistry.dynamicCourseView(dyn));
}

/** 存量会话升级：补齐动态课学习单元，并迁移掌握证据；保留对话与真实作答记录 */
function ensureLearningUpgraded(session) {
  if (!session) return;
  const dynamic = !!session.activeCourseId && session.activeCourseId !== course.id;
  let changed = false;
  if (!session.learning || (dynamic && !Object.keys(session.learning.kps || {}).length)) {
    session.learning = buildLearningForCourse(session.activeCourseId);
    changed = true;
  }
  if (upgradeLearningState(session.learning, dynamic)) changed = true;
  if (ensureKpsInSync(session)) changed = true;
  if (changed) sessionStore.save(session);
}

/**
 * 大纲与学习记录对齐：课程大纲里的知识点若在学习记录中缺失，补齐一条初始记录。
 * 为什么必要：重传同名素材、或改动小节标题都会让 kp id（learningKey）变化，
 * 于是"大纲有 N 个点、learning.kps 只有 M 个"。此时 progress.overallProgress 选不出
 * current（pick 要求 kps[id] 存在）→ 前端 `cur.phase` 抛空指针 → 侧栏整块渲染中断；
 * 报告页与首页也会显示不同的分母。这里补齐即可根治（已有记录一律保留，不回退进度）。
 */
function ensureKpsInSync(session) {
  const learning = session && session.learning;
  if (!learning || !learning.kps) return false;
  let view = null;
  try {
    view = session.activeCourseId === course.id
      ? course
      : (courseRegistry.getDynamicCourse(session.activeCourseId)
        ? courseRegistry.dynamicCourseView(courseRegistry.getDynamicCourse(session.activeCourseId))
        : null);
  } catch (_) { view = null; }
  if (!view || !Array.isArray(view.chapters)) return false;
  let added = false;
  for (const ch of view.chapters) {
    for (const kp of ch.knowledgePoints || []) {
      if (!kp || !kp.id || learning.kps[kp.id]) continue;
      learning.kps[kp.id] = {
        phase: PHASES.NOT_STARTED,
        quizCorrect: 0,
        quizTotal: 0,
        checks: { preview: null, learn: null, review: null },
        assessment: null,
        quizHistory: [],
        lastActivity: null,
      };
      added = true;
    }
  }
  // currentKpId 指向已不存在的点 → 清空，交由整体进度重新挑选
  if (learning.currentKpId && !learning.kps[learning.currentKpId]) learning.currentKpId = null;
  return added;
}

/** 删除会话（重置该课程对话/进度/记忆；前端"重置会话"用） */
function removeSession(sessionId) {
  sessions.delete(sessionId);
  sessionStore.remove(sessionId);
  attachmentStore.clearSession(sessionId);
  // 三层记忆也要清：否则"重置"后 conversation_search 仍能搜到已删对话、
  // 常驻记忆块与事实仍在（与确认框承诺的"清空对话与进度"不符）。
  // 注意只清**本课**（列表/事实/进度块），保留跨课程的学生画像与其他课程记忆。
  try {
    memoryEngine.clearSession(sessionId);
    usageEngine.clear(sessionId);
  } catch (e) {
    console.warn('[memory] 重置时清理记忆失败（已忽略）:', e.message);
  }
}

/** 设置会话的联网模式偏好（首页"是否联网"选择；off / on / auto），并落盘 */
function setWebMode(sessionId, webMode) {
  const mode = ['off', 'on', 'auto'].includes(webMode) ? webMode : 'auto';
  const s = getSession(sessionId);
  s.webMode = mode;
  sessionStore.save(s);
  return mode;
}

/** 删除动态课程后的会话回退：所有绑定该课程的会话回退 python-intro（文件清理由 upload.cleanupCourse 完成） */
function deleteDynamicCourse(courseId) {
  for (const s of sessions.values()) {
    if (s.activeCourseId === courseId) {
      attachmentStore.clearSession(s.id);
      s.activeCourseId = course.id;
      s.learning = (s.learningBackup && Object.keys(s.learningBackup.kps || {}).length)
        ? s.learningBackup
        : createLearningState(course);
      sessionStore.save(s);
    }
  }
}

/**
 * 切换会话绑定的课程（内置 python-intro ↔ 用户上传动态课）
 * @returns {{ok: boolean, courseId: string, title?: string, dynamic?: boolean, error?: string}}
 */
function switchCourse(sessionId, courseId) {
  const session = getSession(sessionId);
  const target = String(courseId || '');
  if (target !== course.id && !courseRegistry.isDynamicCourseId(target)) {
    return { ok: false, error: `课程不存在: ${target}` };
  }
  const dynamic = courseRegistry.isDynamicCourseId(target) ? courseRegistry.getDynamicCourse(target) : null;
  if (courseRegistry.isDynamicCourseId(target) && !dynamic) {
    return { ok: false, error: `课程不存在: ${target}` };
  }
  const isBuiltin = target === course.id;

  // 内置 ↔ 动态切换时互不破坏对方状态：
  // 内置课状态机在切出前备份、切回时恢复；动态课按课程构建节级状态机（学习进度独立）。
  if (dynamic) {
    if (session.activeCourseId === course.id && session.learning) {
      session.learningBackup = session.learning;   // 首次进入动态课前，备份内置进度
    }
    session.learning = buildLearningForCourse(target);
  } else if (isBuiltin) {
    if (session.learningBackup) {
      session.learning = session.learningBackup;   // 从动态课返回：恢复内置进度
    } else if (!session.learning || !Object.keys(session.learning.kps || {}).length) {
      session.learning = createLearningState(course);
    }
  }
  session.activeCourseId = target;
  sessionStore.save(session);
  logger.info('course_switch', `[${sessionId}] 切换到课程 ${target}`);
  return { ok: true, courseId: target, title: dynamic ? dynamic.title : course.title, dynamic: !!dynamic };
}

/** 会话当前绑定的课程元信息（前端课程头展示） */
function getActiveCourse(sessionId) {
  const session = getSession(sessionId);
  const cid = session.activeCourseId || course.id;
  if (cid === course.id) return { course, dynamic: false };
  const dyn = courseRegistry.getDynamicCourse(cid);
  if (!dyn) { session.activeCourseId = course.id; return { course, dynamic: false }; }
  // 视图与学习状态机的 kp key 同源（registry.dynamicCourseView）→ 前端 learning.kps[kp.id] 直接命中
  return { course: courseRegistry.dynamicCourseView(dyn), dynamic: true };
}

/** 动态课程视图（与学习状态机同源）；课程不存在/为内置课时返回 null */
function dynamicViewOf(cid) {
  if (!cid || cid === course.id) return null;
  const dyn = courseRegistry.getDynamicCourse(cid);
  return dyn ? courseRegistry.dynamicCourseView(dyn) : null;
}

/**
 * 做题区（选择题页/代码实践页）判分结果回写主会话学习状态 —— 打通"做题区 ↔ 主对话"链路：
 * 判分以结构化记录（quizHistory + source）沉淀到 learning.kps → 报告错题本/复习清单/统计可见；
 * 答错同时沉淀卡点 painPoints（主对话卡点记录与报告可见）；不做阶段自动推进（阶段由主对话学习流程控制）。
 * @returns {{ok: boolean, error?: string, quizTotal?: number, quizCorrect?: number, mastery?: number}}
 */
/**
 * 服务端复核选择题答案（不信任客户端回传的 correct）。
 * 题库在服务端（内置课程 course.js），因此选择题的对错应由服务端裁定：
 * 找到题干对应题目 → 用标准答案判定；找不到（题干被改写/非内置题）→ 返回 null，
 * 表示无法复核，调用方按未复核处理。
 * @returns {{correct: boolean, explanation?: string}|null} 服务端裁定及题库解析；null=无法复核
 */
function verifyChoiceAnswer(kpId, question, userAnswer, courseId = course.id) {
  const dynamic = courseRegistry.isDynamicCourseId(courseId);
  if (!dynamic) question = locale.canonicalQuestion(question);
  const questions = dynamic ? require('../kb/quiz-gen').cachedQuiz(courseId, kpId)?.questions : findKnowledgePoint(kpId)?.kp.quiz;
  if (!Array.isArray(questions)) return null;
  const norm = (s) => String(s || '').replace(/[\s`"'，。！？、,.:;：；]/g, '').toLowerCase();
  const nq = norm(question);
  if (!nq) return null;
  const item = questions.find((q) => norm(q.q) === nq);
  if (!item) return null;
  const raw = String(userAnswer || '').trim();
  const optIdx = (item.options || []).findIndex((o) => String(o).trim() === raw);
  if (optIdx >= 0) return { correct: 'ABCD'[optIdx] === item.answer, explanation: item.explanation };
  const letter = (raw.match(/^([A-Da-d])(?:$|[\s.:、)）])/) || [])[1];
  const upper = letter ? letter.toUpperCase() : null;
  if (upper) return { correct: upper === item.answer, explanation: item.explanation };
  // 未给字母时，比对选项全文
  return { correct: false, explanation: item.explanation };
}

function recordPracticeAnswer(sessionId, p = {}, grade = null) {
  const session = getSession(sessionId);
  const isDynamic = session.activeCourseId !== course.id;
  // 素材课（user-*）现已具备由 quiz-gen 生成的题库、也会下发练习卡片，
  // 因此同样允许落库——否则卡片显示"答对"但进度/报告/错题本里什么都没有（静默丢数据）。
  const kpId = String(p.kpId || '');
  const rec = session.learning.kps[kpId];
  if (!rec) return { ok: false, error: `知识点不存在: ${kpId}` };
  const kind = p.kind === 'coding' ? 'coding' : 'choice';
  const question = String(isDynamic ? p.question || '' : locale.canonicalQuestion(p.question || '')).trim().slice(0, 300);
  const verifiedGrade = kind === 'coding' ? grade : verifyChoiceAnswer(kpId, question, p.userAnswer, session.activeCourseId);
  const correct = verifiedGrade?.correct;
  if (typeof correct !== 'boolean') return { ok: false, error: kind === 'coding' ? '编程成绩必须通过代码提交接口生成' : '题目已更新或无法核验，请重新获取题目' };
  const verified = true;
  const explanation = verifiedGrade?.explanation ? String(verifiedGrade.explanation).slice(0, 300) : undefined;
  registerQuizResult(session.learning, kpId, question, String(p.userAnswer ?? '').slice(0, 120), correct, explanation);
  // 打上做题区来源标记（主对话注入器据此识别"做题区记录"）
  const h = rec.quizHistory[rec.quizHistory.length - 1];
  if (h) { h.source = kind; h.verified = verified; }

  // 对话内卡片若呈现的是"正式测验"，这一答要一并推进测验题号——与 check_answer 文本路径
  // 共用同一套状态，答完整场才结算梯级门禁凭据（否则对话里练一整轮，进度却纹丝不动）。
  // replay（错题重练）只沉淀历史，绝不能顶替正式作答。
  let quizProgress = null;
  if (kind === 'choice' && !p.replay) {
    const quiz = activeQuizOf(session.learning);
    const idx = Number.isFinite(session.learning.currentQuizIndex) ? session.learning.currentQuizIndex : 0;
    const curQ = quiz && Array.isArray(quiz.questions) ? quiz.questions[idx] : null;
    if (curQ && quiz.kpId === kpId && String(curQ.q) === question) {
      if (!Array.isArray(quiz.answers)) quiz.answers = [];
      quiz.answers.push(correct);
      session.learning.currentQuizIndex = idx + 1;
      const finished = quiz.answers.length === quiz.questions.length;
      if (finished) completeQuiz(session.learning, quiz);
      quizProgress = {
        mode: quiz.mode || null,
        answered: quiz.answers.length,
        total: quiz.questions.length,
        finished,
        allCorrect: finished && quiz.answers.every(Boolean),
      };
    }
  }
  if ((rec.quizHistory || []).length > 50) rec.quizHistory = rec.quizHistory.slice(-50);
  rec.lastActivity = new Date().toISOString();
  if (rec.phase === PHASES.NOT_STARTED) rec.phase = PHASES.LEARNING;
  session.learning.currentKpId = kpId;
  // 答错 → 卡点沉淀（主对话记忆/报告可见）
  if (!correct) {
    if (!rec.painPoints) rec.painPoints = [];
    const pt = { text: `${kind === 'coding' ? '编程题' : '选择题'}答错：${question.slice(0, 40)}`, at: rec.lastActivity };
    if (!rec.painPoints.some((x) => x.text === pt.text)) {
      rec.painPoints.push(pt);
      if (rec.painPoints.length > 20) rec.painPoints = rec.painPoints.slice(-20);
    }
  }
  sessionStore.save(session);
  return { ok: true, correct, verified, quizTotal: rec.quizTotal, quizCorrect: rec.quizCorrect, mastery: computeMastery(rec), quizProgress };
}

function recordCodingGrade(sessionId, kpId, problemId, result) {
  const problem = codingProblems.getProblem(problemId);
  if (!problem || problem.kpId !== kpId || result.error) return { ok: false, error: '无法核验编程成绩' };
  return recordPracticeAnswer(sessionId, {
    kind: 'coding', kpId, question: problem.title, userAnswer: `提交 ${result.passed}/${result.total} 用例通过`,
  }, { correct: result.total > 0 && result.passed === result.total, explanation: result.review?.comment });
}

/** 素材课 kp 标题：优先取大纲里的小节名，避免错题本/卡片上出现 kp hash 这种噪音 */
function dynamicKpTitle(cid, kpId) {
  const dyn = courseRegistry.getDynamicCourse(cid);
  if (!dyn) return kpId;
  const view = courseRegistry.dynamicCourseView(dyn);
  for (const ch of view.chapters || []) {
    const hit = (ch.knowledgePoints || []).find((k) => k.id === kpId);
    if (hit) return hit.title || ch.title || kpId;
  }
  return kpId;
}

/**
 * 错题本列表：聚合当前会话全部知识点的答错记录。
 * 错题本质是 quizHistory 的派生视图（没有独立表），但要点开重练就必须带上题目选项与
 * 标准答案——历史里只存了题干与学生的答案，所以这里回题库补齐（素材课走 quiz-gen 题库）。
 */
async function listMistakes(sessionId) {
  const session = getSession(sessionId);
  ensureLearningUpgraded(session); // 存量会话惰性升级：旧记录也要能进错题本
  const learning = session.learning || {};
  const cid = session.activeCourseId || course.id;
  const dynamic = cid !== course.id;
  // 旧记录的 id 补齐后就落库：否则每次列表都重新生成，前端拿到的 id 一刷新就失效，删不掉
  if (ensureRecordIds(learning)) sessionStore.save(session);
  const courseTitle = dynamic
    ? ((courseRegistry.getDynamicCourse(cid) || {}).title || cid)
    : course.title;
  const out = [];
  for (const [kpId, rec] of Object.entries(learning.kps || {})) {
    const wrong = (rec.quizHistory || []).filter((h) => h && h.correct === false);
    if (!wrong.length) continue;
    let title = dynamic ? dynamicKpTitle(cid, kpId) : kpId;
    let bank = [];
    if (dynamic) {
      const quizGen = require('../kb/quiz-gen');
      const qz = await quizGen.getQuiz(cid, kpId, quizGen.metaOfSection(cid, kpId));
      if (qz) { title = qz.title || title; bank = qz.questions || []; }
    } else {
      const found = findKnowledgePoint(kpId);
      if (found) { title = found.kp.title; bank = found.kp.quiz || []; }
    }
    for (const h of wrong) {
      const q = bank.find((x) => x.q === h.question);
      out.push({
        id: h.id,
        courseId: cid, courseTitle, kpId, kpTitle: title,
        question: h.question,
        userAnswer: h.userAnswer,
        options: (q && q.options) || null,
        answer: (q && q.answer) || null,
        explanation: h.explanation || (q && q.explanation) || '',
        kind: h.source || 'choice',
        at: h.at,
        // 题库里找不到（题库更新过/素材课重生成）→ 只能展示，不能重练
        replayable: !!q,
      });
    }
  }
  out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return { ok: true, count: out.length, mistakes: out };
}

/** 删除错题记录（按 id）：连同该题沉淀的卡点一起清掉，避免报告里"错题没了、卡点还在" */
function deleteMistakes(sessionId, ids) {
  const session = getSession(sessionId);
  ensureLearningUpgraded(session);
  const learning = session.learning || {};
  const wanted = new Set((ids || []).map(String).filter(Boolean));
  if (!wanted.size) return { ok: false, error: '未指定要删除的错题' };
  let removed = 0;
  for (const [kpId, rec] of Object.entries(learning.kps || {})) {
    const hit = (rec.quizHistory || []).filter((h) => h && wanted.has(h.id));
    if (!hit.length) continue;
    removed += removeQuizHistory(learning, kpId, [...wanted]);
    if (Array.isArray(rec.painPoints)) {
      rec.painPoints = rec.painPoints.filter((pt) => !hit.some((h) => String(pt.text || '').includes(String(h.question || '').slice(0, 40))));
    }
  }
  if (removed) sessionStore.save(session);
  return { ok: true, removed };
}

/**
 * 动态课学习进度标记：从本轮工具调用中的教材检索命中 → 更新对应节/章的学习状态。
 * 检索讲解只记录学习活动；提问次数不代表答题成绩，也不能证明已掌握。
 * mock 模式无工具调用记录 → 用用户提问直接检索 top1 兜底（演示模式进度同样可积累）。
 */
async function markDynamicLearning(session, toolCalls, opts = {}) {
  const cid = session && session.activeCourseId;
  if (!cid || cid === course.id) return;
  const dyn = courseRegistry.getDynamicCourse(cid);
  const learning = session.learning;
  if (!dyn || !learning || !learning.kps) return;
  if (/^(大纲|进度|你好|hi|hello|谢谢|谢了|再见|overview|progress)$/i.test(String(opts.query || '').trim()) || /(课程大纲|我的进度|学习进度|有哪些章节|学什么)/.test(opts.query || '')) return;

  // ① 提取本轮 search_knowledge_base 命中（chunk 带 docId/chapter/section）
  const raw = [];
  for (const tc of toolCalls || []) {
    if (tc && tc.name === 'search_knowledge_base' && tc.output && Array.isArray(tc.output.results)) {
      for (const r of tc.output.results) if (r && r.docId && r.chapter) raw.push(r);
    }
  }
  // ② mock 兜底：概览/进度/寒暄之外的自由提问直接检索一次素材库取 top1
  if (!raw.length && opts.mock && opts.query) {
    const q = String(opts.query || '').trim();
    const skip = /^(大纲|进度|你好|hi|hello|谢谢|谢了|再见|大纲|overview|progress)\b/i.test(q) || /(课程大纲|我的进度|学习进度|讲了什么|有哪些章节|学什么)/.test(q);
    if (!skip) {
      try {
        const kbSearch = require('../kb/search'); // 延迟加载防循环依赖
        const top = await kbSearch.searchHybrid(q, { courseId: cid, topK: 1 });
        for (const r of top) if (r && r.docId && r.chapter) raw.push(r);
      } catch (_) { /* 检索失败不影响主流程 */ }
    }
  }
  if (!raw.length) return;

  // ③ 命中 → 章/节 → 状态机 key（与视图 dynamicCourseView 的 id 完全同源）
  // 聚焦截断：一次提问可能命中多节（检索含相近章节），只标记相关度最高的前 2 个不同小节，
  // 避免"问一个问题"把整章都刷成学习中。
  const chapters = dyn.chapters || [];
  const orderedKeys = []; // 按工具返回顺序（相关度降序）去重收集候选 key
  for (const h of raw) {
    const ch = chapters.find((c) => c.docId === h.docId && c.title === h.chapter);
    if (!ch) continue;
    let key = null;
    const sects = ch.sections || [];
    if (sects.length) {
      const sec = h.section ? sects.find((s) => s.title === h.section) : null;
      if (sec) key = courseRegistry.learningKey(ch.docId, ch.title, sec.title);
      else if (!h.section && sects.length === 1) key = courseRegistry.learningKey(ch.docId, ch.title, sects[0].title);
      // 命中章级正文但该章多节且无节信息 → 不标记（避免错标）
    } else {
      key = courseRegistry.learningKey(ch.docId, ch.title, '');
    }
    if (key && !orderedKeys.includes(key)) orderedKeys.push(key);
  }
  const focusKeys = orderedKeys.slice(0, 2); // 本轮聚焦 top-2
  const touched = new Set();
  for (const key of focusKeys) {
    const rec = learning.kps[key];
    if (!rec) continue;
    touched.add(key);
    rec.hitCount = (rec.hitCount || 0) + 1;
    rec.lastActivity = new Date().toISOString();
    // 只升不降：已掌握（含已通过复习测验）的节不该因为"又问了一次"被降回学习中。
    // 原实现无条件覆盖 phase，导致"已掌握"与"学习中"同时出现（isMastered 仍为 true）。
    const target = /复习|回顾/.test(opts.query || '') ? PHASES.REVIEWING : PHASES.LEARNING;
    if ((DYNAMIC_PHASE_ORDER[rec.phase] || 0) < (DYNAMIC_PHASE_ORDER[target] || 0)) rec.phase = target;
  }
  if (touched.size) {
    learning.currentKpId = [...touched][0];
    sessionStore.save(session);
  }
}

/**
 * 素材课的知识点匹配：按小节标题命中（用户说"练练 变量"→ 命中"第二章 变量与类型"）。
 * 判定用"最长公共子串 ≥ 2 字"（比整串包含宽松，比关键词包含精确），取命中标题最长者。
 */
function longestCommonRun(a, b) {
  let best = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = tmp;
    }
  }
  return best;
}

function matchDynamicKp(text, courseId) {
  const dyn = courseRegistry.getDynamicCourse(courseId);
  if (!dyn || !text) return null;
  const view = courseRegistry.dynamicCourseView(dyn);
  const all = view.chapters.flatMap((ch) => (ch.knowledgePoints || []).map((kp) => ({ kp, chapter: ch })));
  const q = String(text).replace(/^(练一练|练练|我想练|预习|学习|复习|做题|讲讲|讲讲看)\s*/g, '').trim();
  const words = new Set(q.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []);
  const chinese = value => (value.match(/[\u3400-\u9fff]+/g) || []).join(' ');
  let best = null;
  let bestScore = 0;
  for (const item of all) {
    const t = String(item.kp.title || '');
    if (!t) continue;
    const overlap = longestCommonRun(chinese(q), chinese(t));
    const score = (overlap >= 2 ? overlap : 0) + (t.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter(w => words.has(w)).reduce((n, w) => n + w.length, 0);
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best;
}
/** 从用户消息中匹配知识点（按标题关键词；内置课专用） */
function matchKnowledgePoint(text) {
  const englishTopics = [
    [/\b(variables?|assignments?)\b/i, 'kp1'], [/\b(data types?|types?)\b/i, 'kp2'],
    [/\b(conditions?|conditionals?|elif|if\s*(?:\/\s*else|statements?)|else\s+clauses?)\b/i, 'kp3'], [/\b(loops?|(?:for|while)\s+(?:loops?|statements?))\b/i, 'kp4'],
    [/\b(functions?|def)\b/i, 'kp5'], [/\b(lists?|dictionar(?:y|ies))\b/i, 'kp6'],
    [/\b(class(?:es)?|objects?|oop)\b/i, 'kp7'],
  ];
  for (const [pattern, id] of englishTopics) if (pattern.test(text)) return findKnowledgePoint(id);
  const keywordMap = [
    ['变量', 'kp1'], ['赋值', 'kp1'],
    ['数据类型', 'kp2'], ['类型', 'kp2'],
    ['条件', 'kp3'], ['判断', 'kp3'],
    ['循环', 'kp4'],
    ['函数', 'kp5'], ['def', 'kp5'],
    ['列表', 'kp6'], ['字典', 'kp6'],
    ['面向对象', 'kp7'], ['类', 'kp7'], ['对象', 'kp7'],
  ];
  for (const [kw, kpId] of keywordMap) {
    if (/^[a-z]+$/.test(kw) ? new RegExp('\\b' + kw + '\\b', 'i').test(text) : text.includes(kw)) {
      const found = findKnowledgePoint(kpId);
      if (found) return found;
    }
  }
  return null;
}

/** 意图识别器（Rule-based router；真实产品可换成小模型分类器） */
function recognizeIntent(text, learning, opts = {}) {
  const t = text.toLowerCase();
  // “解释/是什么”不代表用户要推进当前课程；跨学科问答交给通用角色。
  const learningIntent = () => {
    if (isMetaQuestion(text)) return 'chat';
    const matched = courseRegistry.isDynamicCourseId(opts.courseId)
      ? matchDynamicKp(text, opts.courseId) : matchKnowledgePoint(text);
    const followup = /^(?:我(?:想|要)?|请|帮我)?\s*(?:开始学(?:习)?|学习|讲解|教教我|教一下|讲讲|讲一下|说说|解释|深入|展开|不懂|不会)(?:一下|这个|这里|这部分|它|了)?[。！!？?\s]*$|^(?:(?:i\s+)?(?:want to\s+)?(?:learn|understand)|(?:please\s+)?(?:explain|teach)(?:\s+(?:me|this|that|it))?|i (?:don't|do not) understand)[.!?\s]*$/i.test(text.trim());
    // 联网词表使用二元分词，“光合作用”也会命中“作用”，不能拿它判定学习意图。
    const tokens = new Set(scopeEngine.tokenize(text));
    const domain = scopeEngine.DOMAIN.some(word => /^[a-z]/i.test(word)
      ? tokens.has(word) : word.length > 1 && text.includes(word));
    return matched || followup || domain ? 'learn' : 'chat';
  };

  // 1. 测验进行中，且用户像在回答选项 → answer
  //    注意：currentQuizIndex 可能是 undefined（旧会话/未初始化），必须兜底为 0，
  //    否则答题会被判成闲聊（曾导致"A"被路由到协调者、判分链路断掉）
  const quiz = activeQuizOf(learning);
  const quizIdx = Number.isFinite(learning.currentQuizIndex) ? learning.currentQuizIndex : 0;
  const quizActive = !!quiz && Array.isArray(quiz.questions) && quizIdx < quiz.questions.length;
  if (quizActive) {
    const raw = text.trim();
    const isOption = /^(?:我?选|答案(?:是)?|ans(?:wer)?\s*[:：]?)?\s*[abcd]\s*[.、)）]?(?:\s|$)/i.test(raw)
      || /^(对|错|正确|错误|true|false)$/i.test(raw)
      // 口语化作答："我不太确定，我选 A" / "答案是 B" / "我选C"
      || /(?:我\s*选|选\s*择?|答案\s*(?:是|为)?|answer\s*(?:is)?)\s*[:：]?\s*[abcd]\b/i.test(raw);
    if (isOption) return 'answer';
  }
  // 光说"继续/下一题"这类承接语 → 一律回到出题路径（而非 chat）。
  // 原因：落到 chat 时系统不会预置测验，模型便自行把题目写进正文，出现"正文一题、卡片一题"
  // 的错位。走 quiz 则先由代码按梯级建好试卷，模型拿到真题只做引导。
  if (/^(继续|接着|下一题|下一步|往下|继续吧|接着来|然后呢|然后)\s*[吧。！!…]*$/.test(text.trim())) return 'quiz';
  // English actions follow the same intent names and stage gates as Chinese.
  if (/^(continue|next(?: question| step)?)[.!?\s]*$/i.test(text.trim())) return 'quiz';
  if (/^复习(?:测试|测验|练习|题目)\s+/.test(text.trim())) return 'review_quiz';
  // A topic title may itself contain "计划" / "progress"; explicit topic actions win.
  if (/^(?:开始\s*)?(?:预习|预学)(?:\s|$)|^(?:start\s+)?preview\b/i.test(text.trim())) return 'preview';
  if (/^(?:开始\s*)?学习(?:\s|$)/.test(text.trim())) return 'learn';
  if (/^(?:开始\s*)?复习\s+/.test(text.trim()) && !/复习.*(题|测试|测验|练习|考)/.test(text)) return 'review';
  // Asking for a source fact is read-only, even when its wording resembles a lesson title.
  if (courseRegistry.isDynamicCourseId(opts.courseId) && /根据|依据|教材中|材料中|\b(according to|what is|which|how (?:often|many|much))\b/i.test(text)) return 'chat';
  if (/\b(where (?:should i|to) start|learning plan|what should i learn)\b/.test(t)) return 'chat';
  if (/\b(outline|course overview|curriculum|what does .* cover)\b/.test(t)) return 'course_overview';
  if (/\b(progress|learning report|my status)\b/.test(t)) return 'progress';
  if (/\breview\b.*\b(quiz|test|check|questions?)\b/.test(t)) return 'review_quiz';
  if (/\b(more (?:practice|questions)|practice more|another (?:set|question))\b/.test(t)) return 'practice';
  if (/\bpreview\b/.test(t)) return /\b(quiz|check|test)\b/.test(t) ? 'quiz' : 'preview';
  if (/\b(quiz|test|practice|questions?)\b/.test(t) && !/\b(explain|hint)\b/.test(t)) return 'quiz';
  if (/\b(review|recap|revise|summarize)\b/.test(t)) return 'review';
  if (/\b(learn|explain|teach|what is|how to|understand)\b/.test(t)) return learningIntent();

  // 2. 学习规划类问题 → chat（交给协调者：routeIntent 的 PLANNING 分支命中）
  //    必须放在 learn 规则之前，否则"从哪开始学"会被"开始学"抢走
  if (/从哪(开始|学起|入手)|先学(什么|哪|点)|该学什么|学什么好|怎么安排|如何安排|学习(计划|顺序|路线|节奏)|推荐(学|一下|个)|下一步学|接下来学|有什么建议|该怎么学/.test(text)) {
    return 'chat';
  }

  // 3. 课程相关
  if (/大纲|课程|有什么课|介绍(一下)?(这门)?课|课程介绍|章节|学什么|课程结构|都讲(什么|啥)|讲哪些|讲了什么|包含哪些|有哪些内容|这门课讲|教材讲|目录/.test(t)) return 'course_overview';
  // 4. 进度（提前于 learn：避免"学习进度"被"学习"抢先）
  if (/进度|掌握|学到哪|状态|报告|统计|学习进度|(复习|学习|考试)计划|计划/.test(t)) return 'progress';
  // 5. 复习测试（带题字 → 出复习题）
  if (/复习.*(题|测试|测验|练习|考)/.test(t) || /(题|测试|测验|练习|考).*复习/.test(t)) return 'review_quiz';
  // 5.5 想多练（明确要求刷题）→ practice：按薄弱点 / 指定知识点针对性出题
  //     必须排在"做题/练习"规则之前，否则"练习更多"会被当成随堂测验
  if (/再练|多练|想练|练一练|练习更多|多来几题|再来几题|再来几道|再来一[题道]|换一批|换一[题道]|多点题|多出几道|加强练习|刷题|多做题|巩固练习|还有题吗/.test(text)) {
    return 'practice';
  }
  // 6. 预习
  if (/预习|预学|预览|先看看|提前看/.test(t)) return 'preview';
  // 7. 学习/讲解
  if (/学习|讲解|教教|教一下|讲讲|讲一下|介绍|说说|什么是|是什么|怎么用|开始学|深入|展开|不懂|不会|解释/.test(t)) return learningIntent();
  // 8. 做题
  //    口语化说法尽量收全（"测测我/考考我/来一道题/做点题"…）：这类若落到 chat，
  //    系统不会预置测验，模型就会自行把题目写进正文——既不是互动卡片，
  //    也不进状态机，学生答了无法判分。
  if (/做题|练习|测试|测验|题目|出题|考我|考考我|考一考|测测我|测一测|测试我|检测一下|检验一下|考验我|考试|quiz|来几道|挑战|几道题|几道|几题|出.*[题道]|(来|出|给|做|练|要|想|换|多|还)[一几两些点]*[道个]?题/.test(t)) return 'quiz';
  // 9. 复习
  if (/复习|回顾|巩固|总结/.test(t)) return 'review';

  return 'chat';
}

/**
 * ensureLearningContext — 学习类意图的上下文兜底（真实模式）
 * 模型可能不调 update_progress（例如用 get_learning_progress 代替），
 * 导致 currentKpId 未设置 → 后续出题/判分链路断掉。
 * 当"用户指定了新知识点"或"尚无当前知识点"时，代码代调 update_progress。
 */
function toolContext(session) {
  return { learning: session.learning, courseId: session.activeCourseId || course.id, sessionId: session.id };
}

async function ensureLearningContext(learning, turn, intent, matched, ctx) {
  if (!['preview', 'learn', 'review'].includes(intent)) return;
  // 课外实体提问（"开心超人是什么"）：不做任何课程动作（推进/出题/取讲义），
  // 交由模型简短说明与课程无关并引导回来。
  if (turn.offTopicSubject) return;
  const kpId = (matched && matched.kp.id) || fallbackKpId(learning);
  if (!kpId) return;
  const action = { preview: 'preview', learn: 'learn', review: 'review' }[intent];
  // 每次都尝试推进（幂等，且 update_progress 内部保证"只进不退"）——避免同一个知识点想进阶却不动
  const out = await tools.update_progress.run({ kpId, action }, ctx);
  turn.toolCalls.push({ name: 'update_progress', input: { kpId, action }, output: out });
  // 严格梯级门禁：前置检测未完成 → 代码直接发起那一步的检测，把"跳步"变成"先补这一步"
  if (out && out.gated) {
    // 取"最前置的缺项"：未预习的点想直接复习 → 先做预习自测，而不是随堂练习
    const g = nextGate(learning.kps[kpId]) || { need: out.need, label: out.label };
    const pre = await tools.generate_quiz.run({ kpId, mode: g.need }, ctx);
    turn.toolCalls.push({ name: 'generate_quiz', input: { kpId, mode: g.need }, output: pre });
    turn.gate = { kpId, need: g.need, label: g.label || out.label, message: out.message, quiz: pre };
  }
}

/**
 * ensureAnswerChecked — 判分兜底（真实模式）
 * 学生回复选项（A/B/C/D）且测验进行中时，代码代调 check_answer 完成判分，
 * 结果注入给模型做点评——判分是硬需求，不能赌模型自觉调用。
 * @returns {object|null} 判分结果（供注入 LLM 上下文）
 */
async function ensureAnswerChecked(learning, turn, intent, ctx) {
  if (intent !== 'answer') return null;
  const quiz = activeQuizOf(learning);
  const inProgress = quiz && quiz.answers && quiz.answers.length < quiz.questions.length;
  if (!inProgress) return null;
  // 用户输入必须是选项（A/B/C/D 或选项全文）；支持口语化表达（"答案是 A" / "我不太确定，我选 A" / "选 B"）
  const raw = String(turn.userMessage || '').trim();
  const letterHit = raw.match(/(?:^|[^A-Za-z0-9])([A-Da-d])(?![A-Za-z0-9])/);
  const letter = letterHit ? letterHit[1].toUpperCase() : null;
  const curQ = quiz.questions[quiz.answers.length];
  const fullMatch = curQ && curQ.options && curQ.options.some((o) => raw === o);
  if (!letter && !fullMatch) return null;
  const userAnswer = letter || raw;
  const result = await tools.check_answer.run(
    { kpId: quiz.kpId, question: curQ.q, userAnswer },
    ctx
  );
  turn.toolCalls.push({ name: 'check_answer', input: { kpId: quiz.kpId, question: curQ.q, userAnswer }, output: result });
  return result;
}

/**
 * 对话内互动练习（针对性出题）
 * ------------------------------------------------------------
 * 题量不固定，按「用户所问 + 学习薄弱度」共同决定：
 *   - 用户点名知识点（"练练循环"）→ 只出该点
 *   - 用户要求多练（"练习更多/再来几题"）→ 薄弱点优先，最多 3 个点，首个点 2 题
 *   - 讲解完成后（learn）→ 当前点趁热打铁
 * 题型：选择题 + 编程题（素材课无编程题则纯选择题）。
 * 题组内逐题作答、每题可"问一下"，由前端卡片实现。
 */
function practiceTargets(session, matched) {
  const learning = session.learning || {};
  const ids = Object.keys(learning.kps || {});
  if (!ids.length) return [];
  if (matched && matched.kp && learning.kps[matched.kp.id]) return [matched.kp.id];
  // 薄弱度 = 掌握度模型（低掌握/到期/连错）+ 阶段信号（越靠后越需要巩固）
  const now = Date.now();
  const weakness = (id) => {
    const rec = learning.kps[id] || {};
    let w = weaknessScore(rec, now);
    if (rec.phase === 'reviewing') w += 18;
    else if (rec.phase === 'learning') w += 12;
    else if (rec.phase === 'preview') w += 8;
    if (isMastered(rec)) w -= 20;
    return w;
  };
  const picks = [];
  const cur = learning.currentKpId;
  if (cur && learning.kps[cur]) picks.push(cur);
  for (const id of ids.slice().sort((a, b) => weakness(b) - weakness(a))) {
    if (picks.length >= 3) break;
    if (!picks.includes(id)) picks.push(id);
  }
  return picks.slice(0, 3);
}

/**
 * 正式测验 → 互动卡片。
 * 「随堂练习 / 复习测验」这类正式测验不能在对话里只由模型用文字复述题目：
 * 那样题目由模型自己写，而状态机（learning.quizzes）里存的是题库原题，两者可能不是
 * 同一道题——学生回答"A"时，判分对着的是状态机里的题，就会出现"我明明选对了却说错"。
 * 这里直接把状态机里那场测验的题目原样交给卡片渲染，答完由 recordPracticeAnswer 推进，
 * 从而与 check_answer 文本路径共用同一套状态与梯级门禁。
 */
async function buildOfficialQuizCard(session) {
  const learning = session.learning || {};
  const quiz = activeQuizOf(learning);
  if (!quiz || !Array.isArray(quiz.questions) || !quiz.questions.length) return null;
  const idx = Number.isFinite(learning.currentQuizIndex) ? learning.currentQuizIndex : 0;
  const rest = quiz.questions.slice(idx);
  if (!rest.length) return null; // 已答完：交给下面的"按薄弱点出题"决定要不要再来一轮
  const cid = session.activeCourseId || course.id;
  const dynamic = cid !== course.id;
  let title = quiz.title || (dynamic ? dynamicKpTitle(cid, quiz.kpId) : quiz.kpId);
  if (!dynamic) {
    const found = findKnowledgePoint(quiz.kpId);
    if (found) title = found.kp.title;
  }
  const modeLabel = { preview: '预习自测', learn: '随堂练习', review: '复习测验' }[quiz.mode] || '练习';
  return {
    type: 'practice',
    kpId: quiz.kpId,
    kpTitle: title,
    items: rest.map((q) => ({
      type: 'choice', kpId: quiz.kpId, kpTitle: title,
      q: q.q, options: q.options, answer: q.answer, explanation: q.explanation || '',
    })),
    // official=true：卡片即这场正式测验，答完会推进梯级门禁（由前端随每条作答回传）
    official: true,
    answered: idx,
    total: quiz.questions.length,
    reason: modeLabel,
  };
}

/** 错题本「重练这题」：只重建这一道题（replay，不推进正式测验） */
async function buildReplayCard(session, ctx) {
  const kpId = String(ctx.kpId || '');
  const question = String(session.activeCourseId === course.id ? locale.canonicalQuestion(ctx.question || '') : ctx.question || '');
  const rec = (session.learning || {}).kps && session.learning.kps[kpId];
  if (!rec || !question) return null;
  const cid = session.activeCourseId || course.id;
  const dynamic = cid !== course.id;
  let title = dynamic ? dynamicKpTitle(cid, kpId) : kpId;
  let bank = [];
  if (dynamic) {
    const quizGen = require('../kb/quiz-gen');
    const qz = await quizGen.getQuiz(cid, kpId, quizGen.metaOfSection(cid, kpId));
    if (qz) { title = qz.title || title; bank = qz.questions || []; }
  } else {
    const found = findKnowledgePoint(kpId);
    if (found) { title = found.kp.title; bank = found.kp.quiz || []; }
  }
  const q = bank.find((x) => x.q === question);
  if (!q) return null;
  return {
    type: 'practice',
    kpId, kpTitle: title,
    items: [{ type: 'choice', kpId, kpTitle: title, q: q.q, options: q.options, answer: q.answer, explanation: q.explanation || '' }],
    replay: true, // 前端回传时带上 → 服务端只记历史，不动正式测验
    reason: '错题重练',
  };
}

/**
 * 对话内互动练习（针对性出题）
 * ------------------------------------------------------------
 * 出题一律走互动卡片，避免"模型文字出题"与状态机不同步：
 *   ① 错题本「重练这题」→ 只出这一题（replay）
 *   ② 出题/测验意图（quiz/review_quiz）→ 直接呈现状态机里那场正式测验（答完推进门禁）
 *   ③ 讲解后趁热打铁（learn）/ 主动多练（practice）→ 按薄弱点挑题（只记历史与错题，不授予门禁凭据）
 * 「讲讲这题」（mode=card）不再堆新卡片，否则越问越乱。
 */
async function buildPracticePayload(session, intent, opts = {}) {
  const ctx = opts.context || null;
  if (ctx && ctx.mode === 'card') return null; // 解释题目的追问：只回答，不再出题
  // ① 错题重练：必须先于意图过滤。"重练这道错题：…"这类措辞可能被判成 chat，
  //    若放在意图白名单之后，错题本点"重练"就会静默不出卡片。
  if (ctx && ctx.mode === 'mistake') return buildReplayCard(session, ctx);
  // 梯级门禁兜底：学生想学/想练但前置检测没过，系统当轮已代发起该步检测（turn.gate）。
  // 此时卡片必须呈现**这场检测**（official）——否则卡片只是普通练习，答完门禁永远开着，
  // 而正文明明在说"先把这一步走完"，学生照做却推不动进度。
  if (opts.gate && opts.gate.quiz) {
    const gateCard = await buildOfficialQuizCard(session);
    if (gateCard) return gateCard;
  }
  if (!['preview', 'learn', 'practice', 'quiz', 'review_quiz', 'answer'].includes(intent)) return null;
  // ② 正式测验：卡片就是这场测验本身。
  //    answer 也算：学生用文字答了一题（如回复"A"）后，剩下的题继续用卡片接上，
  //    避免"点卡片是互动式、打字就退回文字出题"两套体验。
  if (intent === 'preview' || intent === 'quiz' || intent === 'review_quiz' || intent === 'answer') {
    const official = await buildOfficialQuizCard(session);
    if (official) return official;
    if (intent === 'preview' || intent === 'answer') return null; // No extra practice after a preview or finished assessment.
  }

  const cid = session.activeCourseId || course.id;
  const dynamic = cid !== course.id;
  const learning = session.learning || {};
  const targets = practiceTargets(session, opts.matched);
  if (!targets.length) return null;
  // 讲解后同一知识点不重复推（用户主动要求多练时不受此限）
  if (intent === 'learn' && session._lastCardKp === targets[0]) return null;

  const items = [];
  for (const kpId of targets) {
    const rec = learning.kps[kpId];
    if (!rec) continue;
    let title = kpId;
    let questions = [];
    if (dynamic) {
      // 素材课：题库由 quiz-gen 从教材生成（缓存优先）
      const quizGen = require('../kb/quiz-gen');
      const qz = await quizGen.getQuiz(cid, kpId, quizGen.metaOfSection(cid, kpId));
      if (!qz) continue;
      title = qz.title;
      questions = qz.questions;
    } else {
      const found = findKnowledgePoint(kpId);
      if (!found) continue;
      title = found.kp.title;
      questions = found.kp.quiz || [];
    }
    if (!questions.length) continue;
    // 错题优先；首个知识点取 2 题、其余 1 题
    const wrongTexts = new Set((rec.quizHistory || []).filter((h) => h && !h.correct).map((h) => h.question));
    const sorted = questions.slice().sort((a, b) => (wrongTexts.has(b.q) ? 1 : 0) - (wrongTexts.has(a.q) ? 1 : 0));
    const take = targets.indexOf(kpId) === 0 ? 2 : 1;
    for (const q of sorted.slice(0, take)) {
      items.push({ type: 'choice', kpId, kpTitle: title, q: q.q, options: q.options, answer: q.answer, explanation: q.explanation || '' });
    }
    // 编程题：内置课才带（素材课无编程题数据）
    if (!dynamic && !items.some((it) => it.type === 'coding')) {
      const prob = codingProblems.getProblems(kpId)[0];
      if (prob) {
        items.push({
          type: 'coding', kpId, kpTitle: title, problemId: prob.id, title: prob.title,
          difficulty: prob.difficulty, description: prob.description, starterCode: prob.starterCode || '',
        });
      }
    }
  }
  if (!items.length) return null;
  session._lastCardKp = targets[0];
  return {
    type: 'practice',
    kpId: targets[0],
    kpTitle: items[0].kpTitle,
    items,
    reason: intent === 'practice' ? '按你最近的薄弱点挑的' : '',
  };
}

/** 互动卡片 → quizPrepared 形状：让提示词把卡片上的题目当 ground truth 交给模型 */
function cardToQuizPrepared(card) {
  if (!card || !Array.isArray(card.items)) return null;
  const questions = card.items
    .filter((it) => it && it.type === 'choice' && it.q)
    .map((it) => ({ q: it.q, options: it.options, answer: it.answer, explanation: it.explanation }));
  if (!questions.length) return null;
  return { title: card.kpTitle || '', total: questions.length, questions };
}

/** 正文里是否"像在出题"：出现成组的选项行（A. / B. 之类），或"第 N 题"+选项 */
function replyLooksLikeQuiz(text) {
  const s = String(text || '');
  // 逐行统计选项行，避免把行内出现的 "A." 也算进去（如 "选 A. 都是错的"）
  const optionLines = s.split('\n').filter((l) => /^\s*[*_\-\s]*[ABCD][.、)）]\s*\S/.test(l)).length;
  if (optionLines >= 2) return true;
  const numbered = /(^|\n)\s*[*_\-\s]*(第\s*\d+\s*题|\d+[.、]\s*\S)/.test(s);
  return numbered && optionLines >= 1;
}

/**
 * ensureQuizCardForReply — 出题兜底的结构性保障（"对话里所有出题都必须是互动答题卡"）
 * ------------------------------------------------------------------
 * 前两道防线（意图识别 + 提示词约束）都是"软"的：模型仍可能自作主张把题目写进正文。
 * 实测"测测我 / 继续 / 再来一题"就会落到 chat 意图并口头出题——这类文字题**没有经过
 * generate_quiz**，状态机里不存在测验，学生即便作答也无法判分、不进入进度与错题本。
 * 这里做最后一道"硬"保障：正文若出现了题目而成品没有卡片，就补一张卡，把出题拉回
 * 可交互、可判分的正轨。
 * @returns {object|null} 补出的卡片；无需补时返回 null
 */
async function ensureQuizCardForReply(session, reply, existingCard) {
  if (existingCard) return null;               // 已有卡片：不重复
  if (!replyLooksLikeQuiz(reply)) return null; // 正文没有出题：不动
  // ① 优先复用状态机里正在进行的测验（题目与判分同源，最准确）
  const official = await buildOfficialQuizCard(session);
  if (official) return official;
  // ② 没有进行中的测验（模型完全没调 generate_quiz）→ 由代码代建一场，
  //    让这些题目变成可判分的正式测验，而不是"考完不知道对错"的口头题。
  const learning = session.learning || {};
  const kpId = learning.currentKpId || fallbackKpId(learning);
  if (!kpId || !learning.kps || !learning.kps[kpId]) return null;
  const rec = learning.kps[kpId];
  // 阶段映射：已进入复习 → 复习测验；否则按当前缺失的检测步骤出题（与梯级门禁一致）
  const gate = nextGate(rec);
  const mode = (rec.phase === PHASES.REVIEWING && !rec.checks?.learn) ? 'learn'
    : (gate && gate.need) || 'learn';
  try {
    const gq = await tools.generate_quiz.run({ kpId, mode }, toolContext(session));
    if (!gq || gq.error || gq.gated) return null;
    return await buildOfficialQuizCard(session);
  } catch (_) {
    return null; // 兜底失败不影响本轮回复
  }
}

/**
 * 解析本轮联网模式（首页选择）：
 *   off  不联网 —— 隐藏 MCP 检索类工具，也不做联网兜底
 *   on   一定联网 —— 无视信号词，强制发起一次联网检索兜底（用户点了"一定联网"）
 *   auto 由 Agent 自己决定 —— 命中联网信号词才兜底；否则模型可在需要时自行调用 MCP 检索工具
 * @returns {'off'|'on'|'auto'}
 */
function resolveWebMode(requested, userMessage) {
  if (requested === 'off' || requested === 'on' || requested === 'auto') return requested;
  // 未显式选择：显式要求联网的话术 → 强制联网；否则自动（元问题不强制联网）
  const msg = String(userMessage || '');
  return (WEB_SIGNAL.test(msg) && !isMetaQuestion(msg)) ? 'on' : 'auto';
}

/**
 * ensureWebSearch — 联网检索兜底（真实模式）
 * 联网检索已统一走 MCP（内置 web_search 已下线）：本函数在「用户要求联网」或
 * 「首页选了必须联网」时代调 MCP 检索工具，把结果注入模型 —— 联网是用户的显式要求，
 * 不能赌模型自觉调用。
 * @returns {object|null} 已解析的检索结果（供注入 LLM 上下文）
 */
async function ensureWebSearch(turn) {
  if (turn.webMode === 'off') return null; // 学生选择本次不联网
  const msg = String(turn.userMessage || '');
  // 元问题（在问"你/系统"本身）不触发检索：字面含"联网/搜"也不该真去搜（否则返回噪音）。
  // 例外：学生用开关**显式**要求联网时尊重其意图（开关是他自己点的）。
  if (isMetaQuestion(msg) && !turn.webExplicit) return null;
  if (turn.webMode !== 'on' && !WEB_SIGNAL.test(msg)) return null;

  // 课程边界闸门：联网检索只服务本课程/编程领域。无关问题（天气/股票/影视…）一律不检索，
  // 并记录拒绝原因，让模型据此如实回应并引导学生回到课程（而不是拿"没有工具"搪塞）。
  const scope = turn.webScope || scopeEngine.checkWebScope(msg, { courseId: turn.courseId });
  turn.webScope = scope;
  if (!scope.allowed) return null;

  // 找到可用的联网检索工具：优先本角色的工具表；若该角色没有（如协调者未被授权 MCP），
  // 回退到持有联网工具的角色（learn/review）——不能因为"路由到了没有联网工具的角色"就放弃联网。
  const routedId = (turn.agent && turn.agent.id) || 'learn';
  let searchName = null;
  let pool = {};
  for (const id of [...new Set([routedId, 'learn', 'review'])]) {
    try {
      const p = mcpBridge.toolsForAgent(id, {});
      const n = Object.keys(p).find((k) => /__(?:tavily_search|search_dev)$/.test(k));
      if (n) { searchName = n; pool = p; break; }
    } catch (_) { /* 单个角色查询失败不影响其他角色 */ }
  }
  if (!searchName) return null; // 全局没有可用的联网检索工具（未接入/全部不可用）→ 用自身知识兜底

  // 去掉请求语气词后作为搜索词（保留原意，截断防超长）
  const query = msg.replace(/请|帮我|麻烦|用联网搜索|联网查|网上检索|网上查|网上搜|查一下|搜一下|搜索一下|一下/g, '').trim().slice(0, 100) || msg;
  const output = await pool[searchName].run({ query, maxResults: 5 }).catch(() => null);
  if (!output || output.error) {
    turn.toolCalls.push({ name: searchName, input: { query }, output: output || { error: '联网工具未返回结果' } });
    return null;
  }

  const results = (output.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    content: (r.content || r.snippet || '').slice(0, 400),
  }));
  const payload = { count: results.length, query, results, tool: searchName, input: { query } };
  turn.toolCalls.push({ name: searchName, input: { query }, output: payload });
  return payload;
}

function appendWebSources(reply, webResult) {
  const urls = [...new Set((webResult?.results || []).map(r => r.url).filter(url => typeof url === 'string' && /^https?:\/\/[^\s<>]+$/.test(url)))].slice(0, 3);
  if (!urls.length || urls.some(url => reply.includes(url))) return reply;
  return reply + '\n\n' + (locale.english() ? 'Search sources:' : '检索来源：') + '\n' + urls.map(url => `- <${url}>`).join('\n');
}

/**
 * ensureReadonlyQuery — 只读查询兜底（真实模式）
 * 课程大纲/学习进度是"必答且数据必须真实"的查询（模型没有课程数据，可能发明
 * 工具名或幻觉"工具故障"）。检测到这些意图时代调只读工具，把真实数据注入模型。
 * @returns {object|null} { name, output }
 */
async function ensureReadonlyQuery(learning, turn, intent, ctx) {
  if (intent === 'course_overview') {
    const out = tools.get_course_overview.run({}, ctx);
    turn.toolCalls.push({ name: 'get_course_overview', input: {}, output: out });
    return { name: 'get_course_overview', output: out };
  }
  if (intent === 'progress') {
    const out = tools.get_learning_progress.run({}, ctx);
    turn.toolCalls.push({ name: 'get_learning_progress', input: {}, output: out });
    return { name: 'get_learning_progress', output: out };
  }
  return null;
}

/** 兜底：讲解/复习/预习前先取该知识点的标准讲义。
 *  目的：让讲解内容来自教材（get_knowledge_point），而不是模型自述；
 *  与 webResult/readonlyResult 同一套"系统代取 + 注入上下文"范式。 */
async function ensureKnowledgePrefetch(learning, turn, intent, matched, ctx) {
  if (courseRegistry.isDynamicCourseId(turn.courseId)) {
    if (!['chat', 'preview', 'learn', 'review'].includes(intent) || /^(你好|谢谢|hi|hello|thanks)[!！。\s]*$/i.test(turn.userMessage.trim())) return null;
    const kpId = matched?.kp.id || fallbackKpId(learning);
    if (intent !== 'chat' && kpId) {
      const out = tools.get_knowledge_point.run({ kpId }, ctx);
      if (!out.error) {
        turn.toolCalls.push({ name: 'get_knowledge_point', input: { kpId }, output: out });
        return out;
      }
    }
    const input = { query: turn.userMessage, topK: 3, ...(matched && intent !== 'chat' ? { kpId: matched.kp.id } : {}) };
    const out = await tools.search_knowledge_base.run(input, ctx);
    turn.toolCalls.push({ name: 'search_knowledge_base', input, output: out });
    return out;
  }
  if (!['preview', 'learn', 'review'].includes(intent)) return null;
  if (turn.offTopicSubject) return null; // 课外提问不取讲义
  const kpId = (matched && matched.kp && matched.kp.id) || fallbackKpId(learning);
  if (!kpId || !learning.kps || !learning.kps[kpId]) return null;
  if (!findKnowledgePoint(kpId)) return null; // 素材课的节 key 不在内置课程里 → 没有标准讲义，跳过（靠检索讲解）
  const out = tools.get_knowledge_point.run({ kpId }, { learning });
  if (!out || out.error) return null;
  turn.toolCalls.push({ name: 'get_knowledge_point', input: { kpId }, output: out });
  return out;
}

/**
 * ensureQuizPrepared — 真实模式出题兜底（提示词约束之外的代码保障）
 * 出题意图下若测验未在进行，由代码代调 generate_quiz 建立测验状态，
 * 并让 LLM 基于"系统已出题"直接展示，防止模型自编题导致状态机不同步。
 * @returns {object|null} 准备好的测验（供注入 LLM 上下文）
 */
async function ensureQuizPrepared(learning, turn, intent, matched, ctx) {
  if (!['preview', 'quiz', 'review_quiz'].includes(intent)) return null;
  const kpId = (matched && matched.kp.id) || fallbackKpId(learning);
  if (!kpId) return null;
  const mode = intent === 'preview' ? 'preview' : intent === 'review_quiz' ? 'review' : 'learn';
  // 仅当"进行中的测验**模式一致**"才跳过兜底；模式不符时必须继续走一遍，
  // 交给 generate_quiz 过梯级门禁（否则学生说"复习测试"会被塞预习自测题且绕过门禁）。
  const quiz = activeQuizOf(learning);
  const inProgress = quiz && quiz.answers && quiz.answers.length < quiz.questions.length;
  if (inProgress && quiz.mode === mode) return null; // 同模式测验进行中，无需兜底
  const gq = await tools.generate_quiz.run({ kpId, mode }, ctx);
  turn.toolCalls.push({ name: 'generate_quiz', input: { kpId, mode }, output: gq });
  // 严格梯级门禁：前置检测未完成 → 退回那一步的检测（想直接练/想考 → 先补这一步）
  if (gq && gq.gated) {
    const g = nextGate(learning.kps[kpId]) || { need: gq.need, label: gq.label };
    const pre = await tools.generate_quiz.run({ kpId, mode: g.need }, ctx);
    turn.toolCalls.push({ name: 'generate_quiz', input: { kpId, mode: g.need }, output: pre });
    turn.gate = { kpId, need: g.need, label: g.label || gq.label, message: gq.message, quiz: pre };
    return pre;
  }
  return gq;
}

/**
 * orchestrateMock — Mock 模式的"规则编排"：按意图显式调用工具。
 * run() 与 runStream() 共用；真实 LLM（ReAct）模式不经过这里。
 * @returns {{targetKpId, kp, chapter, toolResult}}
 */
async function orchestrateMock(learning, turn, intent, userMessage, matched, curKpId) {
  let targetKpId = matched ? matched.kp.id : curKpId;
  if (intent === 'course_overview' || intent === 'progress') targetKpId = null;
  let kp = null, chapter = null, toolResult = null;

  if (intent === 'preview') {
    if (!targetKpId) targetKpId = (getAllKnowledgePoints().find(({ kp: k }) => learning.kps[k.id].phase === PHASES.NOT_STARTED) || {}).kp?.id || curKpId;
    if (targetKpId) {
      const before = learning.kps[targetKpId].phase;
      const tr = await tools.update_progress.run({ action: 'preview', kpId: targetKpId }, { learning });
      turn.toolCalls.push({ name: 'update_progress', input: { action: 'preview', kpId: targetKpId }, output: tr });
      if (before !== tr.phase) turn.phaseChanged.push({ kpId: targetKpId, from: before, to: tr.phase });
    }
  } else if (intent === 'learn') {
    if (!targetKpId) targetKpId = (getAllKnowledgePoints().find(({ kp: k }) => learning.kps[k.id].phase === PHASES.NOT_STARTED || learning.kps[k.id].phase === PHASES.PREVIEW) || {}).kp?.id || null;
    if (targetKpId) {
      const before = learning.kps[targetKpId].phase;
      const tr = await tools.update_progress.run({ action: 'learn', kpId: targetKpId }, { learning });
      turn.toolCalls.push({ name: 'update_progress', input: { action: 'learn', kpId: targetKpId }, output: tr });
      if (before !== tr.phase) turn.phaseChanged.push({ kpId: targetKpId, from: before, to: tr.phase });
    }
  } else if (intent === 'quiz' || intent === 'review_quiz') {
    // 选点顺序：明确匹配 → 进行中的点 → 任意已开始的点 → 首个未掌握点（fallbackKpId）。
    // 最后一步很关键：新学生直接说"做题"时若选不出点，会掉进 fallback 回复"没太理解你的意思"
    // （真实 LLM 模式由 ensureQuizPrepared→fallbackKpId 兜底，mock 模式此前缺这一步）。
    if (!targetKpId) targetKpId = (getAllKnowledgePoints().find(({ kp: k }) => learning.kps[k.id].phase !== PHASES.NOT_STARTED) || {}).kp?.id || null;
    if (!targetKpId) targetKpId = fallbackKpId(learning);
    if (targetKpId) {
      const mode = intent === 'review_quiz' ? 'review' : 'learn';
      const before = learning.kps[targetKpId].phase;
      const tr = await tools.update_progress.run({ action: intent === 'review_quiz' ? 'review' : 'learn', kpId: targetKpId }, { learning });
      turn.toolCalls.push({ name: 'update_progress', input: { action: tr.action, kpId: targetKpId }, output: tr });
      if (before !== tr.phase) turn.phaseChanged.push({ kpId: targetKpId, from: before, to: tr.phase });
      toolResult = await tools.generate_quiz.run({ kpId: targetKpId, mode }, { learning });
      turn.toolCalls.push({ name: 'generate_quiz', input: { kpId: targetKpId, mode }, output: toolResult });
    }
  } else if (intent === 'answer') {
    // 判分、推进题号、整轮全对升级已内聚在 check_answer 工具内
    const quiz = activeQuizOf(learning);
    const q = quiz.questions[learning.currentQuizIndex];
    const beforePhase = learning.kps[quiz.kpId].phase;
    toolResult = await tools.check_answer.run(
      { kpId: quiz.kpId, question: q.q, userAnswer: userMessage.trim() },
      { learning }
    );
    turn.toolCalls.push({ name: 'check_answer', input: { question: q.q, userAnswer: userMessage.trim() }, output: toolResult });
    const afterPhase = learning.kps[quiz.kpId].phase;
    if (afterPhase !== beforePhase) turn.phaseChanged.push({ kpId: quiz.kpId, from: beforePhase, to: afterPhase });
  } else if (intent === 'review') {
    if (!targetKpId) targetKpId = (getAllKnowledgePoints().find(({ kp: k }) => learning.kps[k.id].phase === PHASES.LEARNING) || {}).kp?.id || curKpId;
    if (targetKpId) {
      const before = learning.kps[targetKpId].phase;
      const tr = await tools.update_progress.run({ action: 'review', kpId: targetKpId }, { learning });
      turn.toolCalls.push({ name: 'update_progress', input: { action: 'review', kpId: targetKpId }, output: tr });
      if (before !== tr.phase) turn.phaseChanged.push({ kpId: targetKpId, from: before, to: tr.phase });
    }
  }

  if (targetKpId) {
    const found = findKnowledgePoint(targetKpId);
    if (found) { kp = found.kp; chapter = found.chapter; }
  }

  // 严格梯级门禁（mock 轨迹）：任何被拒的推进都退回"最前置的那一步检测"
  const gatedCall = turn.toolCalls.find((c) => c.output && c.output.gated);
  if (gatedCall && !turn.gate) {
    const gateKpId = gatedCall.output.kpId || targetKpId;
    const g = (learning.kps[gateKpId] && nextGate(learning.kps[gateKpId])) || { need: gatedCall.output.need, label: gatedCall.output.label };
    const pre = await tools.generate_quiz.run({ kpId: gateKpId, mode: g.need }, { learning });
    turn.toolCalls.push({ name: 'generate_quiz', input: { kpId: gateKpId, mode: g.need }, output: pre });
    turn.gate = { kpId: gateKpId, need: g.need, label: g.label || gatedCall.output.label, message: gatedCall.output.message, quiz: pre };
    toolResult = pre;
    targetKpId = gateKpId;
    const found = findKnowledgePoint(gateKpId);
    if (found) { kp = found.kp; chapter = found.chapter; }
  }
  return { targetKpId, kp, chapter, toolResult };
}

/**
 * 会话级串行队列：同一 session 的多轮请求必须顺序执行。
 * 单进程 Node 里，run/runStream 内部有大量 await（LLM 调用、工具、落库），
 * 若同一会话（多标签页 / 脚本并发）同时进入，会交错修改共享的 session.learning /
 * messages，导致进度错乱。这里用「每会话一条 Promise 链」把并举请求排队。
 * 不影响不同会话之间的并发。
 */
const sessionChains = new Map();
function withSessionLock(sessionId, fn) {
  const key = String(sessionId || 'default');
  const prev = sessionChains.get(key) || Promise.resolve();
  // 无论上一轮成功或失败都继续（用 .then(fn, fn)），并把链上错误吞掉避免断裂
  const next = prev.then(fn, fn);
  const keepAlive = next.catch(() => {});
  sessionChains.set(key, keepAlive);
  keepAlive.finally(() => {
    if (sessionChains.get(key) === keepAlive) sessionChains.delete(key); // 链已排空 → 清理，防 Map 无限增长
  });
  return next; // 调用方仍能看到真实结果/异常
}

/**
 * 忠实度标注（**异步、不阻塞回答**）：这是审计用途，前端不消费，因此绝不 await —— 
 * 每轮多等一次 LLM（实测约 0.7s）会直接拖慢学生。
 * 结果落到：运行日志 + 本轮轨迹（下一次落库时带上；不影响本轮回复）。
 * GROUNDING_CHECK=off 可关。
 */
function annotateGroundingAsync(session, turn, reply) {
  if (!groundingEngine.ENABLED) return;
  let sources;
  try { sources = groundingEngine.sourcesFromToolCalls(turn.toolCalls); } catch (_) { return; }
  if (!sources.length) return;
  groundingEngine.checkGrounding(reply, sources)
    .then((g) => {
      if (!g) return;
      turn.grounding = g;
      // 附着到本轮轨迹：此刻 turnLog 已 push（同一 turn.at），下一次 save 会持久化
      const log = session.turnLog || [];
      const last = log[log.length - 1];
      if (last && last.at === turn.at) last.grounding = { verdict: g.verdict, unsupported: g.unsupported };
      if (g.verdict !== 'supported') {
        logger.warn('grounding', `[${session.id}] 忠实度=${g.verdict}；不被支撑：${(g.unsupported || []).join('；').slice(0, 160)}`);
      }
    })
    .catch(() => { /* 标注失败静默：绝不影响主流程 */ });
}

/**
 * 执行一轮 Agent 循环
 * @returns {object} 回复 + Agent 内部轨迹（供前端调试面板展示）
 */
async function run(sessionId, userMessage, opts = {}) {
  // 会话级串行锁 + 用量上下文（AsyncLocalStorage）：深层 LLM 调用把 token 记到本会话
  return withSessionLock(sessionId, () => usageEngine.runWithSession(sessionId, () => runInner(sessionId, userMessage, opts)));
}

function quizIntroduction(intent, card, context, attachments, webAllowed) {
  if (!card?.official || !['preview', 'quiz', 'practice', 'review_quiz'].includes(intent)
    || context || attachments?.length || webAllowed) return null;
  return locale.english()
    ? 'Select an answer on the quiz card below. After you finish, we will review the feedback and choose the next step together.'
    : '请点选下方题卡作答，答错也没关系。完成后我们一起看反馈，再决定下一步。';
}

async function runInner(sessionId, userMessage, { onTool, webMode, context, attachments } = {}) {
  const session = getSession(sessionId);
  const preparedAttachments = prepareAttachments(sessionId, userMessage, attachments);
  const learning = session.learning;
  const courseId = session.activeCourseId || course.id;
  const isDynamicCourse = courseId !== course.id; // 动态课：自由问答模式
  const turn = {
    intent: null,
    userMessage,
    courseId,              // 供课程边界闸门判断是否与课程相关
    toolCalls: [],
    phaseChanged: [],
    at: new Date().toISOString(),
  };

  // 记录用户消息（记忆写入）
  session.turnCount = (session.turnCount || 0) + 1; // 单调轮次（不能用 turnLog.length：它被封顶在 50）
  session.messages.push({ role: 'user', content: userMessage, attachments: preparedAttachments.refs.map((ref) => ({ id: ref.id, name: ref.name, kind: ref.kind })) });
  const memoryUserText = userMessage || '（仅发送了附件）';
  const attachmentNote = preparedAttachments.refs.length
    ? `\n[附件：${preparedAttachments.refs.map((ref) => ref.name).join('、')}]`
    : '';
  memoryEngine.recordMessage(session, { role: 'user', content: memoryUserText + attachmentNote }, session.turnCount); // ② recall：原文落库

  // ---- 1. 意图识别 ----
  const intent = recognizeIntent(userMessage, learning, { courseId });
  turn.intent = intent;

  // ---- 1.5 联网模式（先算，路由需要它） ----
  // off=不联网 / on=一定联网 / auto=由 Agent 自行判断（未随请求带则用会话偏好）
  turn.webMode = webConfig.getConfig().enabled
    ? resolveWebMode(webMode || session.webMode, userMessage)
    : 'off';
  turn.webExplicit = (webMode === 'on' || webMode === 'off'); // 学生用开关显式指定的，需被尊重

  // ---- 1.6 课程边界闸门：先算清本轮是否允许联网检索
  //   联网只服务本课程/编程领域；无关问题（天气/股票/影视…）一律不检索。
  //   结论同时用于：① 兜底链是否代检索 ② 路由（需联网时交给有工具的角色）③ MCP 工具层硬拦截。
  turn.webScope = scopeEngine.checkWebScope(userMessage, { courseId });
  turn.offTopicSubject = scopeEngine.foreignSubject(userMessage, { courseId }); // 课外实体（如开心超人）
  const webAllowed = turn.webMode !== 'off' && turn.webScope.allowed;
  // 同时挂到 session：legacy ReAct 与 graph 的工具护栏都从 session 读取本轮结论
  session._offTopicSubject = turn.offTopicSubject;

  // 通用问答与专用课程角色分别路由；联网仍受本轮开关与课程边界约束。
  const agentId = routeIntent(intent, learning, userMessage);
  const agent = AGENTS[agentId];
  turn.agent = { id: agentId, name: agent.name, emoji: agent.emoji };
  // 交接链：与上一轮不同 → 记录一次 Agent 交接
  const handoff = [];
  if (session.lastAgentId && session.lastAgentId !== agentId) {
    handoff.push({ from: AGENTS[session.lastAgentId].name, to: agent.name });
  }
  session.lastAgentId = agentId;

  // ---- 2. 工具执行 ----
  // 两种范式：
  //   Mock 模式：规则编排（代码显式按意图调用工具，稳定、省 token）
  //   真实 LLM：ReAct 自主调用（模型自己决定调哪个工具，见 llm.reactLoop）
  // 动态课无内置知识点 → 禁用关键词匹配（防止误映射到 python-intro 的 kp）
  const matched = isDynamicCourse ? matchDynamicKp(userMessage, session.activeCourseId) : matchKnowledgePoint(userMessage);
  const curKpId = learning.currentKpId;
  const isMock = llm.detectMode() === 'mock';
  let targetKpId = matched ? matched.kp.id : curKpId;
  if (intent === 'course_overview' || intent === 'progress') targetKpId = null;

  let kp = null, chapter = null, toolResult = null;
  if (isMock && !isDynamicCourse) {
    ({ targetKpId, kp, chapter, toolResult } = await orchestrateMock(learning, turn, intent, userMessage, matched, curKpId));
  }

  // 真实模式兜底（内置课与素材课共用）：学习上下文 + 测验建立 + 判分完成 + 联网 + 只读查询
  // 素材课自 2026-09 起已具备题库（kb/quiz-gen 生成），因此同样走严格梯级与出题兜底；
  // 讲义预取对素材课自然返回空（ensureKnowledgePrefetch 内部已做守卫）。
  let quizPrepared = null;
  let checkResult = null;
  let webResult = null;
  let readonlyResult = null;
  let knowledge = null;
  if (!isMock) {
    {
      await ensureLearningContext(learning, turn, intent, matched, toolContext(session));
      quizPrepared = await ensureQuizPrepared(learning, turn, intent, matched, toolContext(session));
      checkResult = await ensureAnswerChecked(learning, turn, intent, toolContext(session));
      webResult = await ensureWebSearch(turn);
      // 兜底调用也转发 tool 事件（前端状态条/来源坞可见）
      if (webResult && onTool) onTool({ name: webResult.tool, input: webResult.input, output: webResult });
      readonlyResult = await ensureReadonlyQuery(learning, turn, intent, toolContext(session));
      if (readonlyResult && onTool) onTool({ name: readonlyResult.name, input: readonlyResult.input || {}, output: readonlyResult.output });
      knowledge = await ensureKnowledgePrefetch(learning, turn, intent, matched, toolContext(session));
      if (knowledge && onTool) onTool(turn.toolCalls.at(-1));
    }
  }

  // 取目标知识点内容（供 mock 回复与 currentKp 展示）
  if (targetKpId) {
    const found = findKnowledgePoint(targetKpId);
    if (found) { kp = found.kp; chapter = found.chapter; }
  }

  // 互动卡片必须在"生成之前"就定好，并把 cardWillRender 告诉模型：
  // 出题意图下卡片会由系统渲染，若模型不知情，它会按出题惯例把题目和选项再复述一遍，
  // 于是同一道题在对话里出现两次（文字一次 + 卡片一次）。提示词据此要求只做引导、不复述题目。
  const card = await buildPracticePayload(session, intent, { matched, userMessage, context, gate: turn.gate });
  // learn/practice 的卡片是"按薄弱点挑的题"，此前只告诉模型"卡片已发出"却不给它题目内容，
  // 于是模型会自己另编一道题写进正文（正文一题、卡片一题，学生看到两张不同的卷子）。
  // 这里把卡片上的真题一并交给模型：它有 ground truth 就不会另编，且据此只做引导。
  if (card && !quizPrepared) quizPrepared = cardToQuizPrepared(card);

  // ---- 3. LLM 生成（引擎分流：LangGraph 图 / legacy ReAct；mock 走演示引擎） ----
  // 用 scope.runWithWebScope 包裹：让 MCP 工具层（bridge）知道本轮是否允许联网，
  // 从而对模型自作主张调用检索工具做硬拦截（提示词只是软约束）。
  let gen;
  gen = await scopeEngine.runWithWebScope(webAllowed, async () => {
    const introduction = quizIntroduction(intent, card, context, attachments, webAllowed);
    if (introduction) return { reply: introduction, toolCalls: [] };
    if (isMock) {
      return llm.generate({ intent, kp, chapter, toolResult: knowledge || toolResult, ctx: session, userMessage, userContent: preparedAttachments.userContent, attachmentContext: preparedAttachments.attachmentContext, toolCalls: turn.toolCalls, agent, quizPrepared, gate: turn.gate, cardWillRender: !!card });
    }
    if (USE_GRAPH) {
      // run()（非流）无 coding 上下文参数（该能力仅在 runStream 提供）
      return graphEngine.run({ session, userMessage, userContent: preparedAttachments.userContent, attachmentContext: preparedAttachments.attachmentContext, intent, agent, quizPrepared, checkResult, webResult, readonlyResult, knowledge, gate: turn.gate, codingContext: null, cardWillRender: !!card, webMode: turn.webMode, webScope: turn.webScope, offTopicSubject: turn.offTopicSubject });
    }
    return llm.generate({ intent, kp, chapter, toolResult: knowledge || toolResult, ctx: session, userMessage, userContent: preparedAttachments.userContent, attachmentContext: preparedAttachments.attachmentContext, toolCalls: turn.toolCalls, agent, quizPrepared, checkResult, webResult, readonlyResult, gate: turn.gate, cardWillRender: !!card, webMode: turn.webMode, webScope: turn.webScope, offTopicSubject: turn.offTopicSubject });
  });
  const reply = appendWebSources(gen.reply, webResult);
  annotateGroundingAsync(session, turn, reply); // 异步标注，不阻塞回答
  if (gen.toolCalls !== turn.toolCalls) turn.toolCalls = turn.toolCalls.concat(gen.toolCalls || []);

  // ReAct 模式下：阶段变化由 reactLoop 在工具执行前后快照对比得出
  if (!isMock && gen.phaseChanges) {
    turn.phaseChanged = turn.phaseChanged.concat(gen.phaseChanges);
  }

  // ---- 4. 记忆更新 ----
  session.messages.push({ role: 'assistant', content: reply });
  memoryEngine.recordMessage(session, { role: 'assistant', content: reply }, session.turnCount || 0); // ② recall：原文落库
  if (session.messages.length > MAX_HISTORY) {
    session.messages = session.messages.slice(-MAX_HISTORY);
  }

  // ---- 5. 组装响应（含调试轨迹） ----
  turn.reply = reply;
  // 当前知识点：优先取学习状态中被工具设置的（ReAct 模式下更准确）
  const displayKpId = learning.currentKpId || targetKpId;
  const displayFound = displayKpId ? findKnowledgePoint(displayKpId) : null;
  turn.currentKp = displayFound
    ? { kpId: displayFound.kp.id, title: displayFound.kp.title, phase: learning.kps[displayFound.kp.id].phase, phaseLabel: PHASE_LABEL[learning.kps[displayFound.kp.id].phase], mastery: computeMastery(learning.kps[displayFound.kp.id]), masteryEstimate: estimateMastery(learning.kps[displayFound.kp.id]) }
    : null;
  // 动态课：先按本轮检索命中标记节/章学习状态，再按节级状态机算整体进度
  if (isDynamicCourse && agentId !== 'general') {
    await markDynamicLearning(session, turn.toolCalls, { mock: isMock, query: userMessage });
  }
  if (isDynamicCourse) {
    const view = dynamicViewOf(session.activeCourseId);
    turn.progress = view ? overallProgress(learning, view) : emptyProgress();
  } else {
    turn.progress = overallProgress(learning, course);
  }
  session.turnLog.push({
    at: turn.at,
    durationMs: Date.now() - Date.parse(turn.at), // 本轮耗时（后台轨迹用）
    intent,
    agent: turn.agent,
    handoff,
    graphPath: gen.graphPath || null, // LangGraph 实际走过的节点路径
    toolCalls: turn.toolCalls.map((t) => ({ name: t.name, input: t.input, output: t.output })),
    phaseChanged: turn.phaseChanged,
    reactSteps: gen.reactSteps || [],
    replyLen: reply.length,
    grounding: turn.grounding ? { verdict: turn.grounding.verdict, unsupported: turn.grounding.unsupported } : null,
  });
  if (session.turnLog.length > 50) session.turnLog = session.turnLog.slice(-50);
  sessionStore.save(session); // 持久化：轨迹入库后再写回 SQLite（含本轮轨迹）

  // 运行日志留存：本轮关键信息（含工具错误/被拒），前端断开也可追溯
  const errTools = turn.toolCalls.filter((t) => (t.output && t.output.error) || t.rejected);
  logger.info('turn', `[${session.id}] ${intent} → ${agent.name} | 工具${turn.toolCalls.length} | 耗时${turn.durationMs || 0}ms | 回复${reply.length}字`,
    errTools.length
      ? { sessionId: session.id, intent, agent: agent.name, toolCalls: turn.toolCalls.map((t) => ({ name: t.name, error: t.output && t.output.error, rejected: !!t.rejected })), replyPreview: reply.slice(0, 80) }
      : { sessionId: session.id, intent, agent: agent.name, toolCalls: turn.toolCalls.map((t) => t.name) });

  // 记忆维护（真实模式）：三层记忆统一入口——卡点→core 进度块、
  // 摘要（recall 压缩产物）、事实提取→archival。失败不影响主流程。
  if (!isMock) await memoryEngine.upkeep(session, turn, userMessage, null);
  // upkeep 可能更新 summary；再落一次盘，避免本轮摘要要等到下一轮才持久化。
  sessionStore.save(session);

  // 结构性保障：正文里若出现题目却没有卡片（模型未按协议出题），补一张可交互、可判分的卡
  const finalCard = card || (agentId !== 'general' && intent !== 'answer' ? await ensureQuizCardForReply(session, reply, card) : null);
  if (finalCard && !card) {
    logger.warn('card_fallback', `[${session.id}] 模型未走互动卡片而出题，已由代码兜底补卡（intent=${intent}）`);
    sessionStore.save(session);
  }

  return {
    reply,
    intent,
    agent: turn.agent,
    handoff,
    toolCalls: turn.toolCalls,
    phaseChanged: turn.phaseChanged,
    currentKp: turn.currentKp,
    progress: turn.progress,
    mode: llm.runtimeInfo().mode,
    reactSteps: gen.reactSteps || [],
    usage: usageEngine.get(sessionId), // 本会话累计 token/成本（off 无关，纯统计）
    card: finalCard, // 对话内练习卡片；必要时由 ensureQuizCardForReply 兜底补卡
  };
}

/**
 * 流式执行一轮 Agent 循环（SSE）。
 * 回调：onTool(toolCall) 工具被调用；onDelta(text) LLM 输出增量。
 * 与 run() 共享 executeTurn 流程，区别仅在 LLM 生成阶段采用流式。
 */
async function runStream(sessionId, userMessage, opts = {}) {
  // 与 run 共用同一把会话锁 + 用量上下文：同一会话的并发请求（含流式）按到达顺序串行
  return withSessionLock(sessionId, () => usageEngine.runWithSession(sessionId, () => runStreamInner(sessionId, userMessage, opts)));
}

async function runStreamInner(sessionId, userMessage, { onTool, onDelta, context, webMode, attachments } = {}) {
  const session = getSession(sessionId);
  const preparedAttachments = prepareAttachments(sessionId, userMessage, attachments);
  const learning = session.learning;
  const courseId = session.activeCourseId || course.id;
  const isDynamicCourse = courseId !== course.id; // 动态课：自由问答模式
  const turn = {
    intent: null,
    userMessage,
    courseId,              // 供课程边界闸门判断是否与课程相关
    toolCalls: [],
    phaseChanged: [],
    at: new Date().toISOString(),
  };

  session.turnCount = (session.turnCount || 0) + 1; // 单调轮次（不能用 turnLog.length：它被封顶在 50）
  session.messages.push({ role: 'user', content: userMessage, attachments: preparedAttachments.refs.map((ref) => ({ id: ref.id, name: ref.name, kind: ref.kind })) });
  const memoryUserText = userMessage || '（仅发送了附件）';
  const attachmentNote = preparedAttachments.refs.length
    ? `\n[附件：${preparedAttachments.refs.map((ref) => ref.name).join('、')}]`
    : '';
  memoryEngine.recordMessage(session, { role: 'user', content: memoryUserText + attachmentNote }, session.turnCount); // ② recall：原文落库

  // ---- 1. 意图识别 ----
  const intent = recognizeIntent(userMessage, learning, { courseId });
  turn.intent = intent;

  // ---- 1.5 联网模式（先算，路由需要它） ----
  // off=不联网 / on=一定联网 / auto=由 Agent 自行判断（未随请求带则用会话偏好）
  turn.webMode = webConfig.getConfig().enabled
    ? resolveWebMode(webMode || session.webMode, userMessage)
    : 'off';
  turn.webExplicit = (webMode === 'on' || webMode === 'off'); // 学生用开关显式指定的，需被尊重

  // ---- 1.6 课程边界闸门：先算清本轮是否允许联网检索
  //   联网只服务本课程/编程领域；无关问题（天气/股票/影视…）一律不检索。
  //   结论同时用于：① 兜底链是否代检索 ② 路由（需联网时交给有工具的角色）③ MCP 工具层硬拦截。
  turn.webScope = scopeEngine.checkWebScope(userMessage, { courseId });
  turn.offTopicSubject = scopeEngine.foreignSubject(userMessage, { courseId }); // 课外实体（如开心超人）
  const webAllowed = turn.webMode !== 'off' && turn.webScope.allowed;
  // 同时挂到 session：legacy ReAct 与 graph 的工具护栏都从 session 读取本轮结论
  session._offTopicSubject = turn.offTopicSubject;

  // 通用问答与专用课程角色分别路由；联网仍受本轮开关与课程边界约束。
  const agentId = routeIntent(intent, learning, userMessage);
  const agent = AGENTS[agentId];
  turn.agent = { id: agentId, name: agent.name, emoji: agent.emoji };
  const handoff = [];
  if (session.lastAgentId && session.lastAgentId !== agentId) {
    handoff.push({ from: AGENTS[session.lastAgentId].name, to: agent.name });
  }
  session.lastAgentId = agentId;

  // ---- 2. 工具执行（Mock 编排；真实 LLM 交给 ReAct） ----
  const matched = isDynamicCourse ? matchDynamicKp(userMessage, session.activeCourseId) : matchKnowledgePoint(userMessage);
  const curKpId = learning.currentKpId;
  const isMock = llm.detectMode() === 'mock';
  let targetKpId = matched ? matched.kp.id : curKpId;
  if (intent === 'course_overview' || intent === 'progress') targetKpId = null;

  let kp = null, chapter = null, toolResult = null;
  if (isMock && !isDynamicCourse) {
    ({ targetKpId, kp, chapter, toolResult } = await orchestrateMock(learning, turn, intent, userMessage, matched, curKpId));
  }

  // 真实模式兜底：① 学习类意图确保 currentKpId/阶段建立；② 出题意图确保测验建立；
  // ③ 答题意图确保判分完成；④ 显式联网请求确保搜索结果注入；⑤ 大纲/进度只读查询注入真实数据。
  // 模型可能不按协议调工具，代码兜底保证状态机链路不断。
  let quizPrepared = null;
  let checkResult = null;
  let webResult = null;
  let readonlyResult = null;
  let knowledge = null;
  if (!isMock) {
    {
      await ensureLearningContext(learning, turn, intent, matched, toolContext(session));
      quizPrepared = await ensureQuizPrepared(learning, turn, intent, matched, toolContext(session));
      checkResult = await ensureAnswerChecked(learning, turn, intent, toolContext(session));
      webResult = await ensureWebSearch(turn);
      // 兜底调用也转发 tool 事件（前端状态条/来源坞可见）
      if (webResult && onTool) onTool({ name: webResult.tool, input: webResult.input, output: webResult });
      readonlyResult = await ensureReadonlyQuery(learning, turn, intent, toolContext(session));
      if (readonlyResult && onTool) onTool({ name: readonlyResult.name, input: readonlyResult.input || {}, output: readonlyResult.output });
      knowledge = await ensureKnowledgePrefetch(learning, turn, intent, matched, toolContext(session));
      if (knowledge && onTool) onTool(turn.toolCalls.at(-1));
    }
  }

  if (targetKpId) {
    const found = findKnowledgePoint(targetKpId);
    if (found) { kp = found.kp; chapter = found.chapter; }
  }

  // 互动卡片在生成前定好：出题意图下卡片会由系统渲染，模型须知情，
  // 否则会把题目/选项再复述一遍，同一题为出现两次（文字一次 + 卡片一次）。
  const card = await buildPracticePayload(session, intent, { matched, userMessage, context, gate: turn.gate });
  // learn/practice 的卡片是"按薄弱点挑的题"，此前只告诉模型"卡片已发出"却不给它题目内容，
  // 于是模型会自己另编一道题写进正文（正文一题、卡片一题，学生看到两张不同的卷子）。
  // 这里把卡片上的真题一并交给模型：它有 ground truth 就不会另编，且据此只做引导。
  if (card && !quizPrepared) quizPrepared = cardToQuizPrepared(card);

  // ---- 3. 流式 LLM 生成（引擎分流：LangGraph 图 / legacy ReAct） ----
  // ALS：本轮是否允许联网（MCP 工具层据此硬拦截，见 mcp/bridge.js）
  const gen = await scopeEngine.runWithWebScope(webAllowed, async () => {
    const introduction = quizIntroduction(intent, card, context, attachments, webAllowed);
    if (introduction) {
      if (onDelta) onDelta(introduction);
      return { reply: introduction, toolCalls: [] };
    }
    if (!isMock && USE_GRAPH) {
      return graphEngine.run(
        // card 模式也要透传：练习卡片点「让 EduPilot 讲讲这题」时，模型必须知道"这题是答错还是答对、
        // 标准答案是什么"，否则只能凭空猜，出现"你答对了！…这题你选错了"这种自相矛盾的点评。
        { session, userMessage, userContent: preparedAttachments.userContent, attachmentContext: preparedAttachments.attachmentContext, intent, agent, quizPrepared, checkResult, webResult, readonlyResult, knowledge, gate: turn.gate, codingContext: context && (context.mode === 'coding' || context.mode === 'card') ? context : null, cardWillRender: !!card, webMode: turn.webMode, webScope: turn.webScope, offTopicSubject: turn.offTopicSubject },
        { onTool, onDelta }
      );
    }
    return llm.generateStream(
      { intent, kp, chapter, toolResult: knowledge || toolResult, ctx: session, userMessage, userContent: preparedAttachments.userContent, attachmentContext: preparedAttachments.attachmentContext, toolCalls: turn.toolCalls, agent, quizPrepared, checkResult, webResult, readonlyResult, gate: turn.gate, cardWillRender: !!card, webMode: turn.webMode, webScope: turn.webScope, offTopicSubject: turn.offTopicSubject },
      { onTool, onDelta }
    );
  });
  const reply = appendWebSources(gen.reply, webResult);
  if (reply !== gen.reply && onDelta) onDelta(reply.slice(gen.reply.length));
  annotateGroundingAsync(session, turn, reply); // 异步标注，不阻塞回答
  if (gen.toolCalls !== turn.toolCalls) turn.toolCalls = turn.toolCalls.concat(gen.toolCalls || []);

  // ReAct 模式：阶段变化由引擎快照对比得出
  if (!isMock && gen.phaseChanges) {
    turn.phaseChanged = turn.phaseChanged.concat(gen.phaseChanges);
  }

  // ---- 4. 记忆更新 ----
  session.messages.push({ role: 'assistant', content: reply });
  memoryEngine.recordMessage(session, { role: 'assistant', content: reply }, session.turnCount || 0); // ② recall：原文落库
  if (session.messages.length > MAX_HISTORY) session.messages = session.messages.slice(-MAX_HISTORY);

  // ---- 5. 组装响应 ----
  const displayKpId = learning.currentKpId || targetKpId;
  const displayFound = displayKpId ? findKnowledgePoint(displayKpId) : null;
  turn.currentKp = displayFound
    ? { kpId: displayFound.kp.id, title: displayFound.kp.title, phase: learning.kps[displayFound.kp.id].phase, phaseLabel: PHASE_LABEL[learning.kps[displayFound.kp.id].phase], mastery: computeMastery(learning.kps[displayFound.kp.id]), masteryEstimate: estimateMastery(learning.kps[displayFound.kp.id]) }
    : null;
  // 动态课：先按本轮检索命中标记节/章学习状态，再按节级状态机算整体进度
  if (isDynamicCourse && agentId !== 'general') {
    await markDynamicLearning(session, turn.toolCalls, { mock: isMock, query: userMessage });
  }
  if (isDynamicCourse) {
    const view = dynamicViewOf(session.activeCourseId);
    turn.progress = view ? overallProgress(learning, view) : emptyProgress();
  } else {
    turn.progress = overallProgress(learning, course);
  }
  session.turnLog.push({
    at: turn.at,
    durationMs: Date.now() - Date.parse(turn.at), // 本轮耗时（后台轨迹用）
    intent,
    agent: turn.agent,
    handoff,
    graphPath: gen.graphPath || null, // LangGraph 实际走过的节点路径
    toolCalls: turn.toolCalls.map((t) => ({ name: t.name, input: t.input, output: t.output })),
    phaseChanged: turn.phaseChanged,
    reactSteps: gen.reactSteps || [],
    replyLen: reply.length,
    grounding: turn.grounding ? { verdict: turn.grounding.verdict, unsupported: turn.grounding.unsupported } : null,
  });
  if (session.turnLog.length > 50) session.turnLog = session.turnLog.slice(-50);
  sessionStore.save(session); // 持久化：轨迹入库后再写回 SQLite（含本轮轨迹）

  // 运行日志留存：本轮关键信息（含工具错误/被拒），前端断开也可追溯
  const errTools = turn.toolCalls.filter((t) => (t.output && t.output.error) || t.rejected);
  logger.info('turn', `[${session.id}] ${intent} → ${agent.name} | 工具${turn.toolCalls.length} | 耗时${turn.durationMs || 0}ms | 回复${reply.length}字`,
    errTools.length
      ? { sessionId: session.id, intent, agent: agent.name, toolCalls: turn.toolCalls.map((t) => ({ name: t.name, error: t.output && t.output.error, rejected: !!t.rejected })), replyPreview: reply.slice(0, 80) }
      : { sessionId: session.id, intent, agent: agent.name, toolCalls: turn.toolCalls.map((t) => t.name) });

  // 记忆维护（真实模式）：三层记忆统一入口——卡点→core 进度块、
  // 摘要（recall 压缩产物）、事实提取→archival。失败不影响主流程。
  if (!isMock) await memoryEngine.upkeep(session, turn, userMessage, context);
  // upkeep 可能更新 summary；再落一次盘，避免本轮摘要要等到下一轮才持久化。
  sessionStore.save(session);

  // 结构性保障：正文里若出现题目却没有卡片（模型未按协议出题），补一张可交互、可判分的卡
  const finalCard = card || (agentId !== 'general' && intent !== 'answer' ? await ensureQuizCardForReply(session, reply, card) : null);
  if (finalCard && !card) {
    logger.warn('card_fallback', `[${session.id}] 模型未走互动卡片而出题，已由代码兜底补卡（intent=${intent}）`);
    sessionStore.save(session);
  }

  return {
    reply,
    intent,
    agent: turn.agent,
    handoff,
    toolCalls: turn.toolCalls,
    phaseChanged: turn.phaseChanged,
    currentKp: turn.currentKp,
    progress: turn.progress,
    mode: llm.runtimeInfo().mode,
    reactSteps: gen.reactSteps || [],
    usage: usageEngine.get(sessionId), // 本会话累计 token/成本（off 无关，纯统计）
    card: finalCard, // 对话内练习卡片；必要时由 ensureQuizCardForReply 兜底补卡
  };
}

/** 会话列表（后台轨迹页用） */
function listSessions() {
  for (const session of sessions.values()) ensureLearningUpgraded(session);
  return [...sessions.values()];
}

/** 供前端调试面板查看 Agent 内部状态 */
function getSessionInfo(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  ensureLearningUpgraded(s);
  return {
    id: s.id,
    activeCourseId: s.activeCourseId || course.id,
    webMode: s.webMode || 'auto',
    createdAt: s.createdAt,
    messages: s.messages,
    learning: {
      currentKpId: s.learning.currentKpId,
      currentQuizIndex: s.learning.currentQuizIndex,
      currentQuiz: s.learning.currentQuiz
        ? { kpId: s.learning.currentQuiz.kpId, mode: s.learning.currentQuiz.mode, total: s.learning.currentQuiz.questions.length, questions: s.learning.currentQuiz.questions.map((q) => q.q) }
        : null,
      quizzes: Object.entries(s.learning.quizzes || {})
        .map(([kpId, q]) => ({ kpId, mode: q.mode, title: q.title || '', answered: (q.answers || []).length, total: (q.questions || []).length }))
        .filter((q) => q.answered < q.total), // 未完成的测验（可中断恢复）
      kps: Object.fromEntries(
        Object.entries(s.learning.kps).map(([id, rec]) => [
          id,
          { phase: rec.phase, phaseLabel: PHASE_LABEL[rec.phase], mastery: computeMastery(rec), masteryEstimate: estimateMastery(rec), checks: rec.checks || null, assessment: rec.assessment || null, quizCorrect: rec.quizCorrect, quizTotal: rec.quizTotal, quizHistory: (rec.quizHistory || []).slice(-50), painPoints: (rec.painPoints || []).slice(-5), lastActivity: rec.lastActivity || null, review: rec.review || null, legacyProgress: rec.legacyProgress || null },
        ])
      ),
    },
    summary: s.summary || null,                                                      // M1 会话总结
    memories: (s.memories || []).map((m) => ({ type: m.type, text: m.text, at: m.at })), // M3 语义记忆（不含向量）
    turnLog: s.turnLog,
  };
}

module.exports = {
  run, runStream, getSession, getSessionInfo, listSessions, sessions,
  recognizeIntent, switchCourse, getActiveCourse, removeSession, deleteDynamicCourse, setWebMode,
  // 白盒导出（自动化测试用；不影响既有行为）
  markDynamicLearning, ensureLearningUpgraded, buildLearningForCourse, dynamicViewOf,
  recordPracticeAnswer, recordCodingGrade,
  listMistakes,
  deleteMistakes,
  buildPracticePayload, // 白盒：互动卡片选题/正式测验驱动（自动化测试用）
  cardToQuizPrepared,   // 白盒：卡片 → 提示词用 ground truth
  replyLooksLikeQuiz,   // 白盒：正文是否"像在出题"（兜底补卡判据）
  ensureQuizCardForReply, // 白盒：模型未走卡片时的结构性兜底
  prepareAttachments, // 白盒：附件归属与多模态消息转换
  orchestrateMockForTest: orchestrateMock, // 演示编排（测"新生说做题"等路径）
};
