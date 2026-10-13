/**
 * tools.js — 工具层（Agent 的"手脚"）
 * ------------------------------------------------------------
 * 智能体不只是"会聊天"，还能调用工具完成任务。
 * 每个工具是 { name, description, args, run(input, ctx) }：
 *   - name: 工具名（函数调用风格）
 *   - description: 用途说明（真实 LLM 模式下注入 prompt，供模型自主选择）
 *   - args: 参数说明（JSON 字符串，LLM 据此构造参数）
 *   - run: 执行逻辑，返回结构化结果
 *
 * 工具是"自治"的：出题、判分、推进进度等副作用都在工具内部完成，
 * 因此"规则编排"（core.js 显式调用）与"ReAct 自主调用"（LLM 决定）
 * 两种模式可以复用同一套工具，不会产生状态不一致。
 *
 * 这里定义了 6 个教育场景工具：
 *   get_course_overview  获取课程大纲
 *   get_knowledge_point  获取知识点讲解内容
 *   generate_quiz        生成练习题（预习/学习/复习三种模式，复习错题优先）
 *   check_answer         判分并记录结果（整轮全对自动标记已掌握）
 *   update_progress      更新学习阶段（预习→学习→复习）
 *   recommend_next       根据进度推荐下一步学习动作
 */

const { course, findKnowledgePoint, getAllKnowledgePoints } = require('../data/course');
const { PHASES, PHASE_LABEL, setPhase, registerQuizResult, computeMastery, overallProgress, completeQuiz, gateFor, nextGate, CHECK_LABEL } = require('./state');
const { isMastered } = require('../../public/progress');
const kbSearch = require('../kb/search');
const kbQuery = require('../kb/query'); // 查询改写 + HyDE（多路召回融合）
const { sanitizeUntrusted } = require('./sanitize'); // 不可信内容清洗（防注入）
const courseRegistry = require('../kb/course-registry');

/**
 * 动态课程（user-*，用户上传素材）工具守卫：内置课程的状态机工具（出题/判分/
 * 进度/推荐）只对内置课程有意义。动态课是"自由问答"模式——引导模型改用
 * search_knowledge_base 检索该课程内容回答，而非返回内置课程的数据。
 * @returns {boolean} 当前 ctx 是否处于动态课程上下文
 */
function isDynamicCtx(ctx) {
  return !!ctx && !!ctx.courseId && ctx.courseId !== course.id;
}

/** 动态课节级学习状态的标题映射（kp.id = learningKey hash → 显示 title） */
function dynamicKpTitles(cid) {
  const dyn = courseRegistry.getDynamicCourse(cid);
  if (!dyn) return {};
  const out = {};
  for (const ch of courseRegistry.dynamicCourseView(dyn).chapters || []) {
    for (const kp of ch.knowledgePoints || []) out[kp.id] = kp.title;
  }
  return out;
}

/** 缺 kpId 时兜底选点：当前学习点 → 第一条未掌握记录
 *  （内置课=课程顺序，素材课=节顺序；避免"还没有选择知识点"这类直接报错，让新会话也能直接做题/推进） */
function fallbackKpId(learning) {
  const kps = (learning && learning.kps) || {};
  if (learning && learning.currentKpId && kps[learning.currentKpId]) return learning.currentKpId;
  const ids = Object.keys(kps);
  const open = ids.find((id) => !isMastered(kps[id]));
  return open || ids[0] || null;
}

/** 当前活跃测验（测验按知识点独立存储；返回存储里的原对象，保证答题推进直接落库） */
function activeQuizOf(learning) {
  const cur = learning && learning.currentQuiz;
  if (!cur || !cur.kpId) return null;
  const stored = (learning.quizzes && learning.quizzes[cur.kpId]) || null;
  return stored || cur; // 无存储时兼容旧数据
}

/** 开始/恢复某知识点的测验：写入按知识点存储，并设为当前活跃（同一引用，答题推进即落库） */
function beginQuiz(learning, kpId, quiz) {
  if (!learning.quizzes) learning.quizzes = {};
  const obj = { ...quiz, kpId, updatedAt: new Date().toISOString() };
  learning.quizzes[kpId] = obj;
  learning.currentQuiz = obj;
  learning.currentQuizIndex = (obj.answers || []).length;
  learning.currentKpId = kpId;
  return obj;
}

/** 阶段顺序（用于"只升不降"：复习巩固不能让已掌握的点退回去） */
const PHASE_ORDER = { not_started: 0, preview: 1, learning: 2, reviewing: 3, mastered: 4 };

/** 只升不降地推进阶段；返回是否真的推进了。（答错撤销掌握由 registerQuizResult 显式处理） */
function promotePhase(learning, kpId, target) {
  const rec = learning.kps[kpId];
  if (!rec) return false;
  if ((PHASE_ORDER[target] || 0) > (PHASE_ORDER[rec.phase] || 0)) {
    setPhase(learning, kpId, target);
    return true;
  }
  return false;
}

/** 门禁拒绝的统一返回：告诉模型该先带学生做哪一步检测 */
function gateBlocked(kpId, target, gate) {
  return {
    gated: true, kpId, need: gate.need, label: gate.label,
    message: `还不能进入「${PHASE_LABEL[target]}」：${gate.hint}`,
    nextStep: `先用 generate_quiz(mode=${gate.need}) 带学生完成「${gate.label}」`,
  };
}

/**
 * RAG 重排（Reranker）：用 LLM 对检索候选精排（对标 LlamaIndex reranker 思路，零新依赖）。
 * 检索是"快筛"（向量/关键词相似），这里是"精挑"（理解问题与片段的相关性）。
 * 延迟 require('./llm')：避免 llm → tools 循环依赖。调用失败自动降级为原序前 topK。
 * @param {string} query 学生问题
 * @param {Array} candidates 检索候选（含 content 字段）
 * @param {number} topK 精排后保留条数
 */
async function rerankTopResults(query, candidates, topK) {
  try {
    const llm = require('./llm'); // 延迟加载，防循环依赖
    const snip = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 160);
    const items = candidates.slice(0, 8).map((r, i) => `${i}. ${snip(r.content)}`);
    const prompt = [
      `学生问题：${String(query).slice(0, 120)}`,
      `以下是教材检索到的 ${items.length} 个候选片段（0 起编号）。请判断每个片段对回答该问题的价值：真正讲解相关知识点的排前面，只是沾边或不相关的排后面。`,
      items.join('\n\n'),
      '只输出按相关度从高到低排列的编号 JSON 数组（包含全部编号，如 [3,0,1,2]），不要输出其他内容。',
    ].join('\n\n');
    const text = await llm.callApi([{ role: 'user', content: prompt }]);
    const m = String(text || '').match(/\[[\d,\s]+\]/);
    if (!m) return candidates.slice(0, topK);
    const order = JSON.parse(m[0]).map(Number).filter((n) => n >= 0 && n < candidates.length);
    const used = new Set();
    const ranked = [];
    for (const idx of order) { if (!used.has(idx)) { used.add(idx); ranked.push(candidates[idx]); } }
    for (let i = 0; i < candidates.length; i++) { if (!used.has(i)) ranked.push(candidates[i]); }
    return ranked.slice(0, topK);
  } catch (e) {
    return candidates.slice(0, topK); // 重排失败：降级为原序
  }
}

function shortSummary(kp) {
  return `${kp.title}：${kp.summary}`;
}

/** 工具清单文本（注入 ReAct 提示词，供 LLM 选择工具；支持传工具子集白名单） */
function toolsDescription(subset) {
  const pool = subset || tools;
  return Object.values(pool)
    .map((t) => `- ${t.name}${t.args ? `(args: ${t.args})` : ''}：${t.description}`)
    .join('\n');
}

/** 工具速查表（名字清单）：白纸黑字列出本角色全部可用工具名，强化"存在感"，防模型发明/臆造工具名 */
function toolsQuickTable(subset) {
  const pool = subset || tools;
  return Object.values(pool)
    .map((t) => `- ${t.name}`)
    .join('\n');
}

const tools = {
  get_course_overview: {
    name: 'get_course_overview',
    description: '获取当前课程大纲：章节与知识点清单（含各知识点当前阶段）。学生问"课程大纲/这门课学什么/有哪些章节/从哪开始学"时使用',
    args: '{}',
    parameters: {'type':'object','properties':{}},
    run(input, ctx) {
      const cid = (ctx && ctx.courseId) || course.id;
      if (cid !== course.id) {
        // 动态课：两级结构（章 → 节）。sections 映射为 knowledgePoints；
        // 无小节章节（hasSections=false）其内容挂章下，可整章提问
        const dyn = courseRegistry.getDynamicCourse(cid);
        if (!dyn) return { error: `课程不存在: ${cid}` };
        return {
          course: dyn.title,
          description: dyn.description || '',
          dynamic: true,
          chapters: courseRegistry.dynamicCourseView(dyn).chapters.map((c, i) => ({
            id: `ch${i + 1}`,
            title: c.title,
            knowledgePoints: c.knowledgePoints.map(kp => {
              const phase = ctx.learning?.kps[kp.id]?.phase || PHASES.NOT_STARTED;
              return { id: kp.id, title: kp.title, phase, phaseLabel: PHASE_LABEL[phase] };
            }),
          })),
        };
      }
      return {
        course: course.title,
        description: course.description,
        chapters: course.chapters.map((ch) => ({
          id: ch.id,
          title: ch.title,
          knowledgePoints: ch.knowledgePoints.map((kp) => ({
            id: kp.id,
            title: kp.title,
            phase: ctx.learning.kps[kp.id].phase,
            phaseLabel: PHASE_LABEL[ctx.learning.kps[kp.id].phase],
          })),
        })),
      };
    },
  },

  get_knowledge_point: {
    name: 'get_knowledge_point',
    description: '获取指定知识点的固定讲解内容（概述/要点/示例/常见误区）。学生开始预习、学习或复习某知识点、需要讲解正文时使用。注意：这是取标准讲义；在教材中检索特定内容用 search_knowledge_base，教材外的实时信息用联网检索工具（MCP）',
    args: '{"kpId": "知识点id，如 kp1"}',
    parameters: {'type':'object','properties':{'kpId':{'type':'string','description':'知识点 id，如 kp1'}},'required':['kpId']},
    run(input, ctx) {
      if (isDynamicCtx(ctx)) {
        const dyn = courseRegistry.getDynamicCourse(ctx.courseId);
        const lesson = dyn?.lessons?.[input.kpId];
        if (!lesson) return { error: '该节尚未生成教学讲义，可重新导入素材生成完整课程', kpId: input.kpId };
        const { title, chapter, summary, keyPoints, example, pitfalls, sources } = lesson;
        return { kpId: input.kpId, title, chapter, summary, keyPoints, example, pitfalls, sources,
          sourceExcerpts: [...new Set((lesson.questions || []).map(q => q.evidence).filter(Boolean))] };
      }
      const { kp, chapter } = findKnowledgePoint(input.kpId) || {};
      if (!kp) return { error: '未找到该知识点', kpId: input.kpId };
      return {
        kpId: kp.id,
        title: kp.title,
        chapter: chapter.title,
        summary: kp.summary,
        keyPoints: kp.keyPoints,
        example: kp.example,
        pitfalls: kp.pitfalls,
      };
    },
  },

  generate_quiz: {
    name: 'generate_quiz',
    description: '生成练习题并开始一轮全新测验（mode: preview=预习自测 / learn=随堂练习 / review=复习测试，错题优先），返回题目供展示。仅在"开始新的测验"时使用；测验进行中（学生正在答题）严禁使用，直接展示下一题即可',
    args: '{"kpId": "知识点id（可选，默认当前学习的知识点）", "mode": "preview|learn|review"}',
    parameters: {'type':'object','properties':{'kpId':{'type':'string','description':'知识点 id（可选，缺省用当前学习点）'},'mode':{'type':'string','enum':['preview','learn','review'],'description':'预习自测/随堂练习/复习测试'}}},
    async run(input, ctx) {
      const kpId = input.kpId || fallbackKpId(ctx.learning);
      if (!kpId) return { error: '课程暂无可用知识点，请检查课程数据' };
      const mode = input.mode || 'learn';
      if (!['preview', 'learn', 'review'].includes(mode)) return { error: '未知测验模式' };
      const rec = ctx.learning.kps[kpId];
      if (!rec) return { error: '未找到该知识点', kpId };

      // 恢复模式：**同一模式**下该知识点/该节已有未答完的测验 → 接着答，不重新出题（切走再回来可继续）。
      // 必须比对模式：否则学生说"复习测试"而库里躺着未答完的"预习自测"时，
      // 会把预习题当复习题放出去，并绕过下面的梯级门禁。
      const stored = (ctx.learning.quizzes && ctx.learning.quizzes[kpId]) || null;
      const unfinished = stored && (stored.answers || []).length < (stored.questions || []).length;
      if (unfinished && stored.mode === mode) {
        ctx.learning.currentQuiz = stored;
        ctx.learning.currentQuizIndex = stored.answers.length;
        ctx.learning.currentKpId = kpId;
        return {
          resumed: true, kpId, mode: stored.mode, title: stored.title, total: stored.questions.length,
          answered: stored.answers.length, nextQuestion: stored.questions[stored.answers.length],
          note: '该知识点有未完成的测验，已恢复进度：直接展示 nextQuestion，不要重新出题',
        };
      }

      // 严格梯级门禁：随堂练习需先过预习自测；复习测验需先过随堂练习
      const target = { preview: PHASES.PREVIEW, learn: PHASES.LEARNING, review: PHASES.REVIEWING }[mode];
      const gate = gateFor(rec, target);
      if (gate) return gateBlocked(kpId, target, gate);

      let title = '';
      let questions = [];
      if (isDynamicCtx(ctx)) {
        // 素材课：题目由 quiz-gen 从教材内容生成（缓存优先，必要时当场生成）
        const quizGen = require('../kb/quiz-gen'); // 延迟加载，避免与 llm/检索模块的循环依赖
        const qz = await quizGen.getQuiz(ctx.courseId, kpId, quizGen.metaOfSection(ctx.courseId, kpId));
        if (!qz) return { error: '该小节还没有练习题', hint: '可以先用 search_knowledge_base 讲这一节，稍后再来练习' };
        title = qz.title;
        questions = qz.questions.slice();
        if (mode === 'review' && rec.quizHistory.length) {
          const wrongQ = rec.quizHistory.filter((r) => !r.correct).map((r) => r.question);
          const wrongItems = questions.filter((q) => wrongQ.includes(q.q));
          if (wrongItems.length) questions = [...wrongItems, ...questions.filter((q) => !wrongQ.includes(q.q))];
        }
      } else {
        const { kp } = findKnowledgePoint(kpId) || {};
        if (!kp) return { error: '未找到该知识点' };
        title = kp.title;
        questions = kp.quiz.slice();
        // 复习模式：优先抽取之前答错的题
        if (mode === 'review' && rec.quizHistory.length) {
          const wrongQ = rec.quizHistory.filter((r) => !r.correct).map((r) => r.question);
          const wrongItems = kp.quiz.filter((q) => wrongQ.includes(q.q));
          if (wrongItems.length) questions = [...wrongItems, ...kp.quiz.filter((q) => !wrongQ.includes(q.q))];
        }
      }
      if (!questions.length) return { error: '该知识点暂无题目' };
      // 自治：初始化本轮测验（按知识点存储），供 check_answer 推进
      beginQuiz(ctx.learning, kpId, { mode, title, questions, answers: [] });
      promotePhase(ctx.learning, kpId, target);
      return { kpId, mode, title, questions, total: questions.length };
    },
  },

  check_answer: {
    name: 'check_answer',
    description: '判定学生刚回答的选项并推进题号。只有完整随堂/复习测验全对才确认掌握，预习自测不授予掌握。学生回复 A/B/C/D 时必须使用，一次只判刚回答的这一题',
    args: '{"question": "题目原文", "userAnswer": "学生的回答，如 A"}',
    parameters: {'type':'object','properties':{'question':{'type':'string','description':'学生刚回答的题目原文'},'userAnswer':{'type':'string','description':'学生的答案，如 A'}},'required':['question','userAnswer']},
    run(input, ctx) {
      const { kpId, userAnswer } = input;
      const question = isDynamicCtx(ctx) ? input.question : require('../locale').canonicalQuestion(input.question);
      // 工具自治（根治"模型转述题目"导致的匹配失败）：
      // 待判题直接取状态机里的"当前测验下一题"（库中原始对象，自带答案），
      // 模型传的 question 仅作为无测验场景（如直接问某道题）的兜底匹配。
      const quiz = activeQuizOf(ctx.learning);
      const curQ = quiz && quiz.questions[ctx.learning.currentQuizIndex];
      const effKpId = (curQ && quiz.kpId) || kpId || (quiz && quiz.kpId);
      const { kp } = findKnowledgePoint(effKpId) || {};

      // 题目匹配：当前题优先；否则按传参做容错匹配（精确 → 前缀 → 归一化）
      const normText = (s) => String(s).replace(/[\s`"'，。！？、]/g, '').toLowerCase();
      const item = curQ || (kp && (
        kp.quiz.find((q) => q.q === question)
        || kp.quiz.find((q) => question && question.startsWith(q.q))
        || kp.quiz.find((q) => normText(question).startsWith(normText(q.q)))
      ));
      if (!item) return { error: '无法匹配题目', question, hint: '请使用当前测验中的题目原文' };

      const norm = String(userAnswer || '').trim().toUpperCase();
      const letter = norm.replace(/^[A-D][.、)）\s]*/, '').length === 0 ? norm.charAt(0) : null;
      const correct = item.answer === letter || norm === item.answer || norm === item.options[item.answer.charCodeAt(0) - 65];
      const mastery = registerQuizResult(ctx.learning, effKpId, item.q, userAnswer, correct, item.explanation);

      // 自治：推进测验题号 + 记录本轮答题 + 整轮全对 → 标记已掌握
      let quizFinished = false;
      let quizAllCorrect = false;
      let nextQuestion = null;
      // 只有当"当前题"就是被判的题（或模型传参能对上当前题）时才推进
      const answeredCur = curQ && (item === curQ || item.q === curQ.q);
      if (answeredCur) {
        quiz.answers.push(correct);
        ctx.learning.currentQuizIndex += 1;
        quizFinished = quiz.answers.length === quiz.questions.length;
        quizAllCorrect = quizFinished && quiz.answers.every(Boolean);
        if (!quizFinished) nextQuestion = quiz.questions[ctx.learning.currentQuizIndex];
        if (quizFinished) completeQuiz(ctx.learning, quiz);
      }
      const rec = ctx.learning.kps[effKpId];
      const remain = nextGate(rec);
      return {
        kpId: effKpId, question: item.q, userAnswer, correct, answer: item.answer, explanation: item.explanation,
        mastery, assessment: rec.assessment, phase: rec.phase, phaseLabel: PHASE_LABEL[rec.phase],
        checks: rec.checks || null,
        quizMode: quiz?.mode || null, quizFinished, quizAllCorrect, nextQuestion,
        nextCheck: remain ? remain.label : null,
      };
    },
  },

  update_progress: {
    name: 'update_progress',
    description: '更新学习阶段（action: preview=开始预习 / learn=开始学习 / review=进入复习），并自动设置当前知识点。学生说"开始预习/学习/复习某知识点"时使用',
    args: '{"kpId": "知识点id", "action": "preview|learn|review"}',
    parameters: {'type':'object','properties':{'kpId':{'type':'string','description':'知识点 id（可选，缺省用当前学习点）'},'action':{'type':'string','enum':['preview','learn','review'],'description':'开始预习/开始学习/进入复习'}},'required':['action']},
    run(input, ctx) {
      const kpId = input.kpId || fallbackKpId(ctx.learning);
      if (!kpId) return { error: '课程暂无可用知识点，请检查课程数据' };
      const action = input.action;
      const map = { preview: PHASES.PREVIEW, learn: PHASES.LEARNING, review: PHASES.REVIEWING };
      const rec = ctx.learning.kps[kpId];
      if (!rec) return { error: '未找到该知识点', kpId };
      if (!map[action]) return { error: '未知学习阶段', action };
      // 严格梯级门禁：前置检测未通过 → 拒绝推进，引导先完成该步检测
      const gate = gateFor(rec, map[action]);
      if (gate) return gateBlocked(kpId, map[action], gate);
      const advanced = promotePhase(ctx.learning, kpId, map[action]); // 只升不降：复习不把已掌握的点降级
      ctx.learning.currentKpId = kpId;
      const remain = nextGate(rec);
      return {
        kpId, action, phase: rec.phase, phaseLabel: PHASE_LABEL[rec.phase], mastery: computeMastery(rec),
        advanced, nextCheck: remain ? remain.label : null,
      };
    },
  },

  recommend_next: {
    name: 'recommend_next',
    description: '根据当前学习状态推荐下一步学习动作（如学下一知识点/复习/做题）。学生问"接下来学什么/我该怎么做/学完这个然后呢"时使用',
    args: '{"kpId": "知识点id（可选，默认当前）"}',
    parameters: {'type':'object','properties':{'kpId':{'type':'string','description':'知识点 id（可选）'}}},
    run(input, ctx) {
      const learning = ctx.learning;
      const ids = Object.keys(learning.kps || {});
      const dynTitle = (id) => dynamicKpTitles(ctx.courseId)[id] || id;
      const titleOf = (id) => (isDynamicCtx(ctx) ? dynTitle(id) : ((findKnowledgePoint(id) || {}).kp || {}).title || id);
      const kpId = input.kpId || learning.currentKpId;
      if (!kpId) {
        // 没有进行中的知识点：找第一个未开始的（内置课=课程顺序，素材课=节顺序）
        const first = ids.find((id) => learning.kps[id].phase === PHASES.NOT_STARTED);
        return first
          ? { suggestion: 'start_preview', kpId: first, kpTitle: titleOf(first), reason: '课程刚开始，建议从第一个知识点开始预习' }
          : { suggestion: 'all_done', reason: '所有知识点已完成，进入总复习' };
      }
      const rec = learning.kps[kpId];
      if (!rec) return { error: '未找到该知识点', kpId };
      const title = titleOf(kpId);
      switch (rec.phase) {
        case PHASES.NOT_STARTED:
        case PHASES.PREVIEW:
          return { suggestion: 'start_learn', kpId, kpTitle: title, reason: '建议正式学习该知识点' };
        case PHASES.LEARNING:
          return { suggestion: 'start_review', kpId, kpTitle: title, reason: '建议做练习巩固' };
        case PHASES.REVIEWING:
          return { suggestion: 'start_review', kpId, kpTitle: title, reason: '建议完成复习测试' };
        default: {
          const idx = ids.indexOf(kpId);
          const nextId = idx >= 0 ? ids[idx + 1] : null;
          return nextId
            ? { suggestion: 'next_kp', kpId: nextId, kpTitle: titleOf(nextId), reason: '该知识点已掌握，可以学习下一个' }
            : { suggestion: 'all_done', reason: '该知识点已掌握，且已是最后一节' };
        }
      }
    },
  },

  get_learning_progress: {
    name: 'get_learning_progress',
    description: '获取学习旅程状态：每个知识点正处在【预习/学习/复习】哪一阶段、此刻正在引导哪个知识点。学生问"我学到哪了/我的情况/学了哪些/下一步学什么"时使用。注意：三个阶段是教学角色（预习=抛砖引玉、学习=教授知识、复习=巩固知识），不是可量化的百分比——汇报时用阶段叙述，不要换算成百分比或进度条。课程结构用 get_course_overview',
    args: '{}',
    parameters: {'type':'object','properties':{}},
    run(input, ctx) {
      if (isDynamicCtx(ctx)) {
        // 动态课只记录学习覆盖，没有完整测验时保持未评估。
        const ls = ctx.learning || { kps: {} };
        const titleMap = dynamicKpTitles(ctx.courseId);
        const kps = Object.entries(ls.kps || {}).map(([id, rec]) => ({
          kpId: id,
          title: titleMap[id] || id,
          phase: rec.phase,
          phaseLabel: PHASE_LABEL[rec.phase],
          assessment: rec.assessment || null,
          practice: { correct: rec.quizCorrect || 0, total: rec.quizTotal || 0 },
        }));
        return {
          overall: overallProgress(ls, { chapters: [{ knowledgePoints: kps.map(k => ({ id: k.kpId, title: k.title })) }] }),
          knowledgePoints: kps,
          dynamic: true,
          note: '提问和阅读仅代表学习覆盖；没有完成测验的内容尚未评估掌握情况，不能把重复提问当作掌握或虚构成绩',
        };
      }
      const progress = overallProgress(ctx.learning, course);
      const kps = Object.entries(ctx.learning.kps).map(([id, rec]) => {
        const found = findKnowledgePoint(id);
        return {
          kpId: id,
          title: found ? found.kp.title : id,
          phase: rec.phase,
          phaseLabel: PHASE_LABEL[rec.phase],
          assessment: rec.assessment || null,
          practice: { correct: rec.quizCorrect || 0, total: rec.quizTotal || 0 },
        };
      });
      return {
        overall: progress,
        knowledgePoints: kps,
        note: '汇报方式：按"已经预习过 / 正在学 / 已掌握 / 还没开始 / 该复习了"来叙述，并结合学生当前所处阶段给出下一步引导（不要给百分比）',
      };
    },
  },

  search_knowledge_base: {
    name: 'search_knowledge_base',
    description: '在教材知识库中检索相关内容（BM25+向量语义检索），返回带《教材》引用来源的片段。回答知识性问题、需要教材依据时优先使用。注意：这是查教材；教材外的实时信息用联网检索工具（MCP），知识点的固定讲解用 get_knowledge_point',
    args: '{"query": "要检索的问题", "kpId": "知识点id（可选，限定范围）", "topK": "返回条数，默认3"}',
    parameters: {'type':'object','properties':{'query':{'type':'string','description':'检索问题'},'kpId':{'type':'string','description':'限定知识点（可选）'},'topK':{'type':'number','description':'返回条数，默认 3'}},'required':['query']},
    async run(input, ctx) {
      const courseId = ctx.courseId || 'python-intro';
      if (!kbSearch.hasKB(courseId)) {
        return { error: `知识库未构建（${courseId}），请先运行 node server/kb/import.js`, hint: 'data/kb/books 下放入教材 Markdown 后重新导入' };
      }
      const query = String(input.query || '');
      const topK = Math.min(parseInt(input.topK, 10) || 3, 6);
      // 检索阶段多捞候选（top-8），交给 reranker 精挑后只保留 topK 条
      const wide = Math.max(8, topK * 2 + 2);
      // 查询扩展（改写 + HyDE）：多路召回后 RRF 融合，提升口语问句的召回率；失败自动回退单查询
      const expanded = await kbQuery.expandQuery(query);
      const variants = expanded.hyde ? [...expanded.queries, expanded.hyde] : expanded.queries;
      let candidates;
      if (variants.length > 1) {
        // 多路并行检索（原为串行 for-await，延迟随变体数叠加；变体间相互独立，可并发）
        const settled = await Promise.all(variants.map((q) =>
          kbSearch.searchHybrid(q, { topK: wide, kpId: input.kpId, courseId }).catch(() => [])
        ));
        const lists = settled.filter((r) => Array.isArray(r) && r.length);
        const byId = new Map();
        for (const r of lists) for (const c of r) if (!byId.has(c.chunkId)) byId.set(c.chunkId, c);
        candidates = kbQuery.fuseByChunk(lists, byId, wide);
      } else {
        candidates = await kbSearch.searchHybrid(query, { topK: wide, kpId: input.kpId, courseId });
      }
      if (!candidates.length) {
        // 空结果 = 正常查询结果（非错误）：教材无该内容，模型用自身知识讲解
        return { count: 0, results: [], note: '教材知识库确认无相关章节内容（这是正常查询结果，非故障）。请如实告知学生"教材暂未收录这块内容"，然后用自身知识完整讲解' };
      }
      // RAG 重排（Reranker）：候选 > topK 时用 LLM 精排（延迟加载防循环依赖；失败自动降级为原序）
      const results = candidates.length > topK ? await rerankTopResults(query, candidates, topK) : candidates.slice(0, topK);
      // 来源片段做"不可信内容"清洗（去不可见字符 + 截断，防教材/网页类内容夹带指令）
      const safeResults = results.map((r) => ({ ...r, content: sanitizeUntrusted(String(r.content || ''), 4000) }));
      return { count: safeResults.length, engine: safeResults[0] ? safeResults[0].engine : null, query, queriesUsed: expanded.queries.length + (expanded.hyde ? 1 : 0), results: safeResults };
    },
  },

  conversation_search: {
    name: 'conversation_search',
    description: '回溯检索**以往对话原文**（含已被移出上下文窗口的更早对话、其他课程的对话）。学生说"我之前问过/你上次说过/我们之前聊到哪了"、或需要回顾早前约定与答错记录时使用。注意：这是查历史对话；查教材用 search_knowledge_base',
    args: '{"query": "要回溯的问题或关键词", "limit": "返回条数，默认5", "scope": "all|course|session（默认 all=含其他课程）"}',
    parameters: {'type':'object','properties':{'query':{'type':'string','description':'要回溯的问题或关键词'},'limit':{'type':'number','description':'返回条数，默认 5'},'scope':{'type':'string','enum':['all','course','session'],'description':'检索范围：all=全部历史（默认）/ course=仅本课程 / session=仅本会话'}},'required':['query']},
    async run(input, ctx) {
      const sessionId = (ctx && ctx.sessionId) || '';
      const memStore = require('../store/memoryStore');
      const sc = String(input.scope || 'all');
      const opts = { limit: Math.max(1, Math.min(parseInt(input.limit, 10) || 5, 10)) }; // 上下界都夹：负数会 dump 整段历史
      if (sc === 'course') opts.courseId = (ctx && ctx.courseId) || undefined;
      if (sc === 'session') opts.sessionId = sessionId;
      // scope=all：不限定课程/会话，跨课程回溯
      if (sc === 'all' && sessionId) opts.sessionId = undefined;
      const hits = await memStore.searchRecall(sessionId || (ctx && ctx.courseId), String(input.query || ''), opts);
      if (!hits.length) {
        return { count: 0, results: [], note: '没有找到相关的历史对话记录（这是正常结果，非故障）。如实告知学生"我们的历史对话里没有找到相关内容"即可' };
      }
      return {
        count: hits.length,
        results: hits.map((h) => ({ at: h.at.slice(0, 10), role: h.role === 'user' ? '学生' : '老师', content: h.content.slice(0, 300) })),
        note: '以上是历史对话原文片段，可作为"之前说过什么"的依据；引用时用自然语言描述，不要说"检索到X条记录"',
      };
    },
  },
};

/**
 * 联网信号（ensureWebSearch 兜底 + chat 路由到学习 Agent 共用，避免两处正则漂移）。
 * 联网检索本身已统一走 MCP（无内置 web_search 工具）。
 */
const WEB_SIGNAL = /联网|网上|检索|搜|搜索|资讯|最新版本|最新消息|实时|新闻|查一下|查查|查一查|查资料/;

/**
 * 元问题/质疑（在问"你/系统"本身，而不是要查资料）。
 * 为什么需要：学生问"你是不是刚才联网查了资料？""系统是不是坏了？"时，
 * 字面含"联网"会命中 WEB_SIGNAL，导致真的发起一次检索、返回一堆无关结果
 * （实测：该问题触发了搜索并返回"移民指南/iPhone 故障"等噪音）。
 * 这类提问应交给模型如实回答，绝不触发检索。
 */
const META_QUESTION = /(你|您)(是不是|是否|有没有|有没|刚才|刚刚|之前|真的)|你的(接口|工具|系统|后台|服务)|系统(是不是|是否|有没有|出|坏)|(接口|工具|系统|服务)\s*(是不是|是否)?\s*(坏|故障|抽风|连不上|挂|异常|报错)|你在(干|做)什么|你是谁|在吗|测试一下|你能(联网|搜索)吗|会不会(联网|搜索)/;

/** 是否是对助手/系统本身的元提问（不应触发联网检索） */
function isMetaQuestion(msg) {
  return META_QUESTION.test(String(msg || ''));
}

module.exports = { tools, toolsDescription, toolsQuickTable, WEB_SIGNAL, isMetaQuestion, META_QUESTION, fallbackKpId, activeQuizOf, beginQuiz };
