/* Offline English lessons use the same topic IDs and assessment state. */
const { course } = require('../data/course_en');
const { translate, display } = require('../locale');
const { overallProgress } = require('../../public/progress');
const phases = { not_started: 'Not started', preview: 'Previewing', learning: 'Learning', reviewing: 'Reviewing', mastered: 'Mastered' };
const topic = id => course.chapters.flatMap(c => c.knowledgePoints).find(k => k.id === id);
function questionBlock(questions, index = 0) {
  const q = display(questions[index]);
  return q ? `**Question ${index + 1} of ${questions.length}**\n\n${q.q}\n\n${(q.options || []).map((o, i) => `${'ABCD'[i]}. ${o}`).join('\n')}\n\nReply A, B, C, or D.` : 'Choose a topic and ask for a quiz to begin.';
}
module.exports = function generate(turn) {
  const { ctx, intent } = turn;
  const kp = topic(turn.kp?.id || ctx.learning.currentKpId);
  if (turn.gate?.quiz) {
    const gate = turn.gate;
    return `📌 Complete the **${translate(gate.label)}** before moving on.\n\n` +
      (turn.cardWillRender ? 'Choose your answers on the practice card below.' : questionBlock(gate.quiz.questions || []));
  }
  if (String(ctx.activeCourseId || '').startsWith('user-')) {
    const registry = require('../kb/course-registry');
    const view = registry.dynamicCourseView(registry.getDynamicCourse(ctx.activeCourseId));
    if (intent === 'progress') {
      const p = overallProgress(ctx.learning, view);
      return `**Your progress**\n\nTopics explored: ${p.studied}/${p.total}. Verified mastery: ${p.mastered}/${p.total}.`;
    }
    if (intent === 'course_overview') return `**${view.title}**\n\n` + view.chapters.map(ch => `- ${ch.title}`).join('\n');
    const hits = require('../kb/search').search(turn.userMessage, { courseId: ctx.activeCourseId, topK: 3 });
    return hits.length ? '**Source excerpts**\n\n' + hits.map((h, i) => `**${i + 1}. ${h.docId}**\n\n${String(h.content).slice(0, 300)}`).join('\n\n') + '\n\n> Offline demo: these are original source excerpts. Connect a model for an explanation in English.'
      : 'No matching passages found in this material. Try a different question or choose a chapter.';
  }
  if (intent === 'course_overview') return `📚 **${course.title}**\n\n${course.description}\n\n` + course.chapters.map(ch => `**${ch.title}**\n${ch.knowledgePoints.map(k => '- ' + k.title).join('\n')}`).join('\n\n') + '\n\nTry **Preview variables** to begin.';
  if (intent === 'progress') return '**Your learning journey**\n\n' + course.chapters.flatMap(ch => ch.knowledgePoints.map(k => `- ${k.title}: ${phases[ctx.learning.kps[k.id]?.phase] || phases.not_started}`)).join('\n');
  if (intent === 'answer') {
    const check = turn.toolResult || turn.checkResult;
    if (check && !check.error) return `${check.correct ? '✅ Correct!' : `The correct answer is **${check.answer}**.`} ${translate(check.explanation || '')}\n\n` +
      (check.quizFinished ? (check.quizAllCorrect ? 'All answers correct! Continue to the next learning stage.' : 'Set complete. Review the explanations and try again.') : (turn.cardWillRender ? 'Continue with the next question below.' : questionBlock(ctx.learning.currentQuiz?.questions || [], ctx.learning.currentQuizIndex)));
  }
  if (['quiz', 'review_quiz', 'practice'].includes(intent)) {
    const result = turn.toolResult || turn.quizPrepared;
    return turn.cardWillRender ? '🎯 Your practice is ready. Choose an answer on each card below; your progress is saved as you go.' : questionBlock(result?.questions || []);
  }
  if (kp && ['preview', 'learn', 'review'].includes(intent)) {
    if (intent === 'preview') return `🔎 **Preview: ${kp.title}**\n\nBefore we begin, what do you already know about this topic? Where might you use it?\n\n**Ideas to explore**\n${kp.keyPoints.map(k => '- ' + k).join('\n')}\n\nTry **Preview quiz** to check your starting point.`;
    if (intent === 'review') return `🔁 **Review: ${kp.title}**\n\n${kp.summary}\n\n${kp.keyPoints.map(k => '- ' + k).join('\n')}\n\nExplain these ideas in your own words, then try **Review test** to verify your understanding.`;
    return `📖 **${kp.title}**\n\n${kp.summary}\n\n**Key ideas**\n${kp.keyPoints.map(k => '- ' + k).join('\n')}\n\n**Example**\n${kp.example}\n\n**Common pitfalls**\n${kp.pitfalls.map(k => '- ' + k).join('\n')}\n\nTry **Quiz** to check your understanding, or ask about anything that is unclear.`;
  }
  return 'I can guide you through **Preview → Learn → Review**. Try **Preview variables**, **Learn loops**, **Quiz**, **Review**, **My progress**, or **Course overview**.\n\nThis is offline demo mode, using built-in lessons. Connect a model for open-ended explanations.';
};
