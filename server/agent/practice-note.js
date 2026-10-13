/**
 * practice-note.js — 做题区记录 → 主对话注入摘要（llm / LangGraph 双引擎共用）
 * 让主对话 Agent "记得"学生在选择题页/代码实践页的近期作答（打通做题区 ↔ 主对话记忆）。
 */
const { findKnowledgePoint } = require('../data/course');

/** 汇总该会话"做题区（choice/coding）"最近 limit 条答题记录为可读文本；无记录返回 '' */
function practiceNote(session, limit = 3) {
  const kps = session && session.learning && session.learning.kps;
  if (!kps) return '';
  const hits = [];
  for (const [id, rec] of Object.entries(kps)) {
    for (const h of rec.quizHistory || []) {
      if (h.source === 'choice' || h.source === 'coding') {
        const found = findKnowledgePoint(id);
        hits.push({
          kpTitle: found ? found.kp.title : id,
          correct: !!h.correct,
          q: String(h.question || '').slice(0, 40),
          ua: h.userAnswer ? `（你的答案：${String(h.userAnswer).slice(0, 30)}）` : '',
          sourceCn: h.source === 'coding' ? '编程题' : '选择题',
        });
      }
    }
  }
  if (!hits.length) return '';
  return hits.slice(-limit)
    .map((x) => `${x.sourceCn}${x.correct ? '答对' : '答错'}「${x.kpTitle}：${x.q}」${x.correct ? '' : x.ua}`)
    .join('；');
}

/** 在系统提示内容后追加做题记录附注（无记录时原样返回） */
function appendToSystemPrompt(baseContent, session) {
  const note = practiceNote(session);
  if (!note) return baseContent;
  return `${baseContent}\n\n【做题区近期记录】${note}\n（学生刚才在选择题/编程实践里做过这些题，讲解与追问时可自然衔接；不要把"是否答对"当作评分或指责依据。）`;
}

module.exports = { practiceNote, appendToSystemPrompt };
