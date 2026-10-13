/**
 * coding/grader.js — 编程题提交判分
 * 两步判分：
 *   1. 客观判分：可信 harness 在独立学生命名空间执行，学生输出不作为通过凭据
 *   2. LLM 点评：把题目 + 代码 + 用例结果发给模型，产出 score/comment/hints
 */

const { runPython } = require('./runner');
const llm = require('../agent/llm');
const { getProblem } = require('./problems');

/** 从 LLM 输出中提取 JSON（容忍 ```json 包裹与前后杂文） */
function extractJson(text) {
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch (_) {}
  return null;
}

/**
 * 提交判分
 * @param {string} kpId
 * @param {string} problemId
 * @param {string} code
 * @returns {Promise<{problemId, title, passed, total, results, review, error?}>}
 */
async function gradeSubmission(kpId, problemId, code) {
  const problem = getProblem(problemId);
  if (!problem) return { error: '题目不存在', problemId };
  if (problem.kpId !== kpId) return { error: '题目与知识点不匹配', problemId };
  if (!String(code).trim()) return { error: '代码不能为空', problemId };

  // ① 客观判分：逐用例运行检查
  const results = [];
  let passed = 0;
  const r = await runPython(String(code), { timeoutMs: problem.timeoutMs || 4000, checks: problem.testCases.map(tc => tc.check) });
  const protocol = /^EDUPILOT_CHECKS:([01]+)\r?\n/.exec(r.stdout || '');
  const valid = !r.error && !r.rejected && !r.timeout && r.exitCode === 0 && protocol && protocol[1].length === problem.testCases.length;
  for (const [index, tc] of problem.testCases.entries()) {
    const pass = !!valid && protocol[1][index] === '1';
    if (pass) passed++;
    results.push({
      desc: tc.desc,
      pass,
      output: r.rejected ? '安全拦截' : r.timeout ? '运行超时' : ((protocol ? r.stdout.slice(protocol[0].length) : r.stdout) + r.stderr).trim().slice(0, 200),
    });
  }

  // ② LLM 点评（失败不影响判分结果）
  let review = null;
  try {
    const prompt = [
      '你是 Python 教学助教，正在给学生的编程作业写点评。',
      `题目：${problem.title}（${problem.difficulty}）`,
      `题目要求：${problem.description}`,
      `学生代码：\`\`\`python\n${code}\n\`\`\``,
      `客观测试：${passed}/${problem.testCases.length} 个用例通过。`,
      require('../locale').english()
        ? 'Return English feedback as JSON: {"score": 0-100, "comment": "1-2 sentences", "hints": ["up to 3 suggestions"]}.'
        : '请输出点评（中文），严格 JSON 格式：{"score": 0-100 整数, "comment": "1-2 句总评", "hints": ["改进建议1", "改进建议2", "最多3条"]}',
    ].join('\n');
    const text = llm.detectMode() === 'api' ? await llm.callApi([{ role: 'user', content: prompt }]) : '';
    review = extractJson(text);
    if (review && typeof review.score === 'number') {
      review.score = Math.max(0, Math.min(100, Math.round(review.score)));
    }
  } catch (e) {
    console.warn('[grader] LLM 点评失败:', e.message);
  }

  return {
    problemId,
    title: problem.title,
    passed,
    total: problem.testCases.length,
    results,
    review,
  };
}

module.exports = { gradeSubmission };
