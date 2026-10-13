/**
 * mock.js — 演示对话引擎（LLM 适配层的 mock 实现）
 * ------------------------------------------------------------
 * 在没有 API Key 时，用"模板 + 知识库 + 意图"生成教学式回复，
 * 让你先把 预习→学习→复习 的完整流程跑起来、看清 Agent 骨架。
 * 接入真实 LLM 后，本文件不再被调用（见 llm.js 的 mode 切换）。
 */

const { course, findKnowledgePoint, getAllKnowledgePoints } = require('../data/course');
const { PHASES, PHASE_LABEL, computeMastery, overallProgress, STAGE_TEACHING } = require('./state');
const kbSearch = require('../kb/search'); // 动态课演示回答：同步 BM25 检索素材库
const courseRegistry = require('../kb/course-registry');

function pct(mastery) {
  return Math.round(mastery * 100);
}

/** 选项字母化 A/B/C/D */
function letters(options) {
  return options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n');
}

/** 出题消息（供前端展示题目与"待判分"状态）；题目缺失时给安全兜底，绝不让演示模式崩 */
function buildQuizBlock(items, index) {
  const list = Array.isArray(items) ? items : [];
  const q = list[index];
  if (!q) {
    // 常见于：门禁被拦（gated 结果没有 questions）或题目已被答完
    return '这组题目暂时还没有准备好，回复「**预习**」或「**学习**」我们换个知识点继续～';
  }
  return `**第 ${index + 1} 题（共 ${list.length} 题）**\n\n${q.q}\n\n${letters(q.options || [])}\n\n> 直接回复 A/B/C/D 告诉我你的答案～`;
}

module.exports = {
  /** 门禁引导（mock）：按顺序学习——先补前置检测，并展示第一题 */
  gateNotice(gate) {
    const gq = gate.quiz || {};
    const lines = [
      `📌 先别急着往下走～我们按顺序来：${gate.message}`,
      ``,
      `先完成「**${gate.label}**」${gq.title ? `（${gq.title}）` : ''}：`,
      ``,
    ];
    if (gq.questions && gq.questions.length) lines.push(buildQuizBlock(gq.questions, 0));
    else lines.push(`回复「**${gate.need === 'preview' ? '预习' : '做题'}**」我带你开始。`);
    return lines.join('\n');
  },

  /** 课程介绍 */
  courseOverview() {
    const chapters = course.chapters
      .map((ch, i) => `第 ${i + 1} 章 ${ch.title}（${ch.knowledgePoints.map((kp) => kp.title).join('、')}）`)
      .join('\n');
    return [
      `📚 欢迎来到《${course.title}》！`,
      ``,
      `${course.description}`,
      ``,
      `**课程大纲**`,
      chapters,
      ``,
      `我们可以这样开始：`,
      `1. 回复「**预习 变量**」— 先了解知识点全貌`,
      `2. 回复「**学习 函数**」— 深入讲解某个知识点`,
      `3. 回复「**做题**」— 随堂练习巩固`,
      `4. 回复「**我的进度**」— 查看学习进度`,
    ].join('\n');
  },

  /** 预习引导：不直接给答案，用问题引发思考（预习 Agent 人格） */
  preview(ctx, kp, chapter, overview) {
    const questions = kp.keyPoints
      .slice(0, 2)
      .map((kp) => kp.replace(/[。；;]$/, '？'))
      .join('\n');
    const related = (overview && overview.find((o) => o.kpId === kp.id)?.next || []).join('、');
    return [
      `🔎 **我是预习引导师**——先不急着给答案，我们把这个知识点"预演"一遍。`,
      ``,
      `**预习环节：「${kp.title}」**`,
      ``,
      `先试着回答这几个问题（答不上来也没关系）：`,
      ``,
      questions,
      ``,
      `**本知识点会讲到：**`,
      ...kp.keyPoints.map((k) => `- ${k}`),
      ``,
      `> 💡 预习阶段不要求掌握，先建立印象。`,
      `准备好后回复「**学习 ${kp.title}**」开始正式讲解，或者回复「**做题**」先试试水。`,
    ].join('\n');
  },

  /** 学习讲解（学习 Agent 人格） */
  learn(ctx, kp, chapter) {
    return [
      `📖 **我是讲解老师**——我们正式开始上课！`,
      ``,
      `**正式学习：「${kp.title}」（${chapter.title}）**`,
      ``,
      `**一句话理解**`,
      kp.summary,
      ``,
      `**核心要点**`,
      ...kp.keyPoints.map((k, i) => `${i + 1}. ${k}`),
      ``,
      `**示例**`,
      kp.example,
      ``,
      `**常见误区**`,
      ...kp.pitfalls.map((p) => `- ⚠️ ${p}`),
      ``,
      `这部分清楚了吗？回复「**做题**」来两道题检验一下，或者告诉我哪里没懂～`,
    ].join('\n');
  },

  /** 出题 */
  quiz(ctx, result, index) {
    return buildQuizBlock(result.questions, index);
  },

  /**
   * 卡片已渲染时的引导语（mock）：题目在互动卡片上，正文只做引导。
   * 若照旧把题目写进正文，同一道题会出现两遍（正文一次 + 卡片一次）。
   */
  cardGuide(kind, label, total) {
    const n = Number(total) > 0 ? `（共 ${Number(total)} 题）` : '';
    if (kind === 'gate') {
      return [`📌 先别急着往下走～我们按顺序来，先把「**${label}**」这一步走完${n}。`, ``, `题目已经发到下面的答题卡里，**点选项作答**就行，答完我会逐题点评。`].join('\n');
    }
    return [`🎯 题目已就绪${n}，已发到下面的**答题卡**里。`, ``, `点选项作答即可，答完我会点评并接着往下走。`].join('\n');
  },

  /** 判分回复（cardWillRender=true 时不再复述下一题——剩余题目由互动答题卡接上） */
  answerResult(ctx, check, kp, nextIndex, quizItems, roundDone = false, roundAllCorrect = false, cardWillRender = false) {
    const rec = ctx.learning.kps[kp.id];
    const lines = [];
    if (check.correct) {
      lines.push(`✅ **回答正确！** ${check.explanation}`);
    } else {
      lines.push(`❌ **答错啦，没关系～** 正确答案是 **${check.answer}**。`);
      lines.push(check.explanation);
    }
    const answers = ctx.learning.currentQuiz?.answers || [];
    lines.push(`这一组练习你答对了 **${answers.filter(Boolean).length}/${answers.length}**，每道题我都记着呢。`);
    if (nextIndex < quizItems.length) {
      lines.push(``);
      lines.push(cardWillRender ? '剩下的题已经发到下面的答题卡里，**点选项继续作答**就行～' : buildQuizBlock(quizItems, nextIndex));
    } else {
      lines.push(``);
      const mode = ctx.learning.currentQuiz?.mode;
      if (roundAllCorrect && mode === 'review' && rec.assessment?.passed) {
        lines.push(`🎉 **全部答对！**「${kp.title}」的复习测验通过了，这个知识点我就给你记上**已掌握**。`);
      } else if (mode === 'preview') {
        lines.push(`预习自测已完成，用来了解你的起点。接下来回复「**学习**」进入讲解。`);
      } else if (roundAllCorrect && mode === 'learn') {
        lines.push(`🎉 **全部答对！**随堂练习通过了，「${kp.title}」可以进入**复习巩固**——回复「**复习**」来一轮测验，全对就确认掌握。`);
      } else {
        lines.push(`一组题做完了～回复「**复习**」我们把答错的题再练一遍，或者「**学习**」让我换个角度再讲给你听。`);
      }
    }
    return lines.join('\n');
  },

  /** 复习总结（复习 Agent 人格） */
  review(ctx, kp, chapter, wrongList) {
    const lines = [
      `🔁 **我是考核教练**——复习是为了把"不会"变成"会"。`,
      ``,
      `**复习环节：「${kp.title}」**`,
      ``,
      `**知识点速览**`,
      `- ${kp.summary}`,
      ...kp.keyPoints.slice(0, 3).map((k) => `- ${k}`),
    ];
    if (wrongList.length) {
      lines.push(``, `**上次答错的题（重点回顾）**`);
      wrongList.forEach((w) => {
        const answer = kp.quiz.find(q => q.q === w.question)?.answer;
        lines.push(`- ❌ ${w.question}${answer ? `（正确答案 ${answer}）` : ''}`);
      });
    }
    lines.push(``, `回复「**复习测试**」开始本知识点复习测试，全部答对即标记为**已掌握**！`);
    return lines.join('\n');
  },

  /** 学习情况（按教学阶段叙述，不做百分比折算） */
  progress(ctx) {
    const progress = overallProgress(ctx.learning, course);
    const cur = progress.current;
    const lines = [
      `📚 **你现在的学习情况**`,
      ``,
      cur
        ? `我正带着你学的是《${cur.title}》，这一步是「${PHASE_LABEL[cur.phase]}」。${(STAGE_TEACHING[cur.phase] || {}).teacher || ''}`
        : `这门课的每个知识点都还没开始，我们从第一章挑一个开始吧。`,
      ``,
      `**各知识点的位置**`,
    ];
    for (const ch of course.chapters) {
      lines.push(``, `**${ch.title}**`);
      for (const kp of ch.knowledgePoints) {
        const rec = ctx.learning.kps[kp.id];
        const isCur = cur && cur.kpId === kp.id ? ' 👉（就在这一步）' : '';
        lines.push(`- ${kp.title}：${PHASE_LABEL[rec.phase]}${isCur}`);
      }
    }
    lines.push(``, `要不要继续？想让我讲透就说「**学习 ${cur ? cur.title : '第一章'}**」，想巩固一下就说「**复习**」。`);
    return lines.join('\n');
  },

  /** 演示模式不能生成开放问答：如实说明，不套用当前课程讲义。 */
  generalAnswer(turn) {
    const courseId = turn.ctx && turn.ctx.activeCourseId;
    const hits = kbSearch.search(String(turn.userMessage || ''), { courseId, topK: 3 });
    if (require('../locale').english()) {
      return hits.length
        ? '**Source excerpts**\n\n' + hits.map(h => `**${h.docId}**\n\n${String(h.content).slice(0, 300)}`).join('\n\n') + '\n\n> Offline demo: connect a model in Settings for open-ended educational answers.'
        : 'I can help with questions across subjects. This is offline demo mode; connect a model in Settings for open-ended educational answers.';
    }
    return hits.length
      ? '**相关资料原文**\n\n' + hits.map(h => `**${h.docId}**\n\n${String(h.content).slice(0, 300)}`).join('\n\n') + '\n\n> 当前为离线演示模式；在设置中连接模型后，可获得通用教育问答与讲解。'
      : '我可以帮你解答不同学科的问题。当前为离线演示模式，请在设置中连接模型后使用通用教育问答。';
  },

  /** 兜底闲聊 */
  fallback(userMessage) {
    return [
      `🤔 我没太理解你的意思～「${userMessage.slice(0, 20)}」`,
      ``,
      `你可以试试这样说：`,
      `- 「**预习 变量**」— 开始预习`,
      `- 「**学习 循环**」— 讲解知识点`,
      `- 「**做题**」— 随堂练习`,
      `- 「**复习**」— 复习巩固`,
      `- 「**我的进度**」— 查看进度`,
      `- 「**课程大纲**」— 查看课程`,
    ].join('\n');
  },

  /**
   * 动态课（用户上传素材）演示回答：mock 模式无 LLM，用同步 BM25 检索素材库，
   * 把命中的片段拼成"引用式"回答——让无 Key 环境也能演示上传素材问答。
   * 真实模式（ReAct + 向量）走 search_knowledge_base 工具，不走这里。
   */
  dynamicAnswer(turn, courseId) {
    const query = String(turn.userMessage || '').trim();
    const dyn = courseRegistry.getDynamicCourse(courseId);
    const title = dyn ? dyn.title : courseId;

    if (turn.intent === 'progress' && dyn) {
      const view = courseRegistry.dynamicCourseView(dyn);
      const p = overallProgress(turn.ctx.learning, view);
      return [`**《${title}》学习情况**`, `已学习 ${p.studied}/${p.total} 节，已验证掌握 ${p.mastered}/${p.total} 节。`,
        '提问和阅读记录学习覆盖；素材课尚无完整测验，掌握情况未评估。',
        ...view.chapters.flatMap(ch => ch.knowledgePoints.map(kp => `- ${kp.title}：${PHASE_LABEL[turn.ctx.learning.kps[kp.id].phase]}`))].join('\n\n');
    }

    // 课程概览类提问 → 给素材的章节列表（两级：章 → 节）
    if (/大纲|课程|介绍|有哪些章节|学什么|章节/.test(query)) {
      const chapters = (dyn && dyn.chapters && dyn.chapters.length) ? dyn.chapters : [];
      const lines = [];
      chapters.forEach((c, i) => {
        const sections = c.sections || [];
        lines.push(`${i + 1}. ${c.title}`);
        sections.forEach((s, j) => lines.push(`    ${i + 1}.${j + 1} ${s.title}`));
      });
      const list = lines.length ? lines.join('\n') : '（素材未识别出章节）';
      return [
        `📚 **《${title}》**（用户上传素材）`,
        ``,
        dyn && dyn.description ? dyn.description : '',
        ``,
        `**目录**`,
        list,
        ``,
        `> 💡 向我提问素材里的内容，例如「1.2 节讲了什么」，我会从《${title}》中检索回答。`,
      ].join('\n');
    }

    // 其他提问 → 检索素材片段
    const hits = kbSearch.search(query, { courseId, topK: 3 });
    if (!hits.length) {
      return [
        `📖 我在《${title}》中没有检索到与「${query.slice(0, 30)}」相关的内容。`,
        ``,
        `你可以换个问法，或问我素材里别的知识点～`,
      ].join('\n');
    }
    const blocks = hits.map((h, i) => {
      const src = `${h.docId}${h.chapter ? ' · ' + h.chapter : ''}`;
      return `**片段 ${i + 1}**（来源：《${src}》）\n\n${String(h.content).slice(0, 300)}`;
    });
    return [
      `🔎 在《${title}》中找到 ${hits.length} 条相关内容：`,
      ``,
      blocks.join('\n\n'),
      ``,
      `> ⚠️ 当前为演示模式（无 LLM Key），以上为素材原文检索结果。配置真实 LLM 后可获得讲解式回答。`,
    ].join('\n');
  },
};
