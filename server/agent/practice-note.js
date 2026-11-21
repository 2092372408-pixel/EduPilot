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
          at: h.at || '',
        });
      }
    }
    for (const evidence of rec.practiceEvidence || []) {
      if (evidence.kind !== 'coding_attempt') continue;
      const found = findKnowledgePoint(id);
      const outcome = evidence.independent
        ? '新变式首次提交通过，未请求本题提示'
        : evidence.correct ? '本题已通过；本次不计独立验证'
          : evidence.verified ? '本题仍有检查未通过' : '本次执行未完成验证';
      hits.push({ at: evidence.at || '', diagnostic: true,
        text: `诊断练习「${found ? found.kp.title : id}」：${outcome}，第${evidence.attempt}次提交，${evidence.passed}/${evidence.total}项检查通过，本题提示${evidence.hintsUsed}次`,
      });
    }
  }
  if (!hits.length) return '';
  return hits.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-limit)
    .map((x) => x.diagnostic ? x.text : `${x.sourceCn}${x.correct ? '答对' : '答错'}「${x.kpTitle}：${x.q}」${x.correct ? '' : x.ua}`)
    .join('；');
}

/** 在系统提示内容后追加做题记录附注（无记录时原样返回） */
function appendToSystemPrompt(baseContent, session) {
  const note = practiceNote(session);
  if (!note) return baseContent;
  return `${baseContent}\n\n【做题区近期记录】${note}\n（可结合记录衔接讲解与追问；诊断练习仅记录本题内的提示使用，不能推断没有外部帮助。订正与新变式首次通过分别说明，不据此宣布长期掌握或跳过课程复习测验。）`;
}

module.exports = { practiceNote, appendToSystemPrompt };
