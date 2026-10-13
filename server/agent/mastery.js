/**
 * mastery.js — 知识点掌握度估计（个性化用；**不用于授予/撤销"已掌握"**）
 * ------------------------------------------------------------
 * 与 public/progress.js 的二元门禁严格区分：
 *   · 门禁（isMastered / gateFor）：凭「完整复习测验全对」这一条客观证据判定"已掌握/未掌握"，
 *     是阶段推进的唯一凭据 —— 本模块绝不修改 rec.phase / rec.assessment。
 *   · 掌握度（本模块）：对"当前掌握得怎么样"做连续估计（0~1），用于
 *     ① 自适应难度 ② 薄弱点精准补弱（练习/复习挑点）③ 报告页学情分析。
 *
 * 算法（轻量、可解释、无需训练）：
 *   - 对答题历史做**时间衰减加权**（越近的作答权重越高）得到加权正确率；
 *   - 复习测验通过 → 下限抬升；被撤销掌握 → 上限压制；
 *   - 结合**练习样本量**给出置信度（样本少则向 0.5 收缩，避免"答一题就满分"）。
 * 纯函数，便于单测；不依赖 LLM 与外部服务。
 */

/** 时间衰减系数：每往前一次作答，权重乘以此值 */
const RECENCY_DECAY = 0.85;
/** 参与估计的最大历史条数（保留最近 N 次） */
const MAX_ATTEMPTS = 20;
/** 置信度饱和样本量：练够这么多题，置信度接近 1 */
const CONFIDENCE_SATURATION = 8;
/** 先验（样本不足时向它收缩） */
const PRIOR = 0.5;
/** 收缩强度：样本量 0 时完全用先验，样本充足时几乎不收缩 */
const SHRINK_K = 3;

/**
 * 计算单个知识点记录的掌握度。
 * @param {object} rec learning.kps[kpId]
 * @param {number} [now] 时间戳（测试可注入）
 * @returns {{
 *   score:number,          // 0~1 掌握度估计（已按置信度收缩）
 *   raw:number,            // 未收缩的加权正确率
 *   confidence:number,     // 0~1 置信度（样本量决定）
 *   level:'weak'|'developing'|'proficient'|'strong',
 *   label:string,          // 中文档位（学生可见，避免百分比）
 *   attempts:number,
 *   reasons:string[]
 * }}
 */
function estimateMastery(rec, now = Date.now()) {
  const empty = {
    score: PRIOR, raw: PRIOR, confidence: 0, level: 'developing', label: '待评估',
    attempts: 0, reasons: ['尚无答题记录'],
  };
  if (!rec || typeof rec !== 'object') return empty;

  const history = Array.isArray(rec.quizHistory) ? rec.quizHistory.slice(-MAX_ATTEMPTS) : [];
  const attempts = history.length;
  const reasons = [];

  // ① 时间衰减加权正确率（历史按时间正序，越靠后越近）
  let wSum = 0;
  let wCorrect = 0;
  for (let i = 0; i < history.length; i++) {
    const ageFromEnd = history.length - 1 - i;
    const w = Math.pow(RECENCY_DECAY, ageFromEnd);
    wSum += w;
    if (history[i] && history[i].correct === true) wCorrect += w;
  }
  let raw = wSum > 0 ? wCorrect / wSum : PRIOR;

  // ② 客观证据修正（只调估计，不动阶段）
  const passedReview = !!(rec.assessment && rec.assessment.passed === true && rec.assessment.mode === 'review');
  const failedReview = !!(rec.assessment && rec.assessment.passed === false);
  if (passedReview) {
    raw = Math.max(raw, 0.85);
    reasons.push('复习测验已通过');
  } else if (failedReview) {
    raw = Math.min(raw, 0.7);
    reasons.push('最近复习测验未通过');
  }
  // ③ 近期连续答错 → 上限压制（对"刚错完还在讲已掌握"很关键）
  const tail = history.slice(-3);
  if (tail.length >= 2 && tail.every((h) => h && h.correct === false)) {
    raw = Math.min(raw, 0.45);
    reasons.push('最近连续答错');
  }
  // ④ 练习量为 0 但已走过学习阶段 → 给一个中性偏低起点（说明"学过、未验证"）
  if (attempts === 0) {
    const touchedLearn = !!(rec.checks && rec.checks.learn);
    if (touchedLearn) { raw = 0.4; reasons.push('已学未练'); return finalize(raw, 0.25, 0, reasons, 'developing'); }
    return empty;
  }

  // ⑤ 置信度：样本量 + 证据强度
  const volConf = Math.min(1, attempts / CONFIDENCE_SATURATION);
  const evidenceConf = passedReview ? 0.25 : 0;
  const confidence = Math.min(1, Math.round((volConf * 0.9 + evidenceConf) * 100) / 100);

  // ⑤b 原因说明：样本少/错题多时给出可解释依据（档位需要理由，避免"薄弱却说不出为什么"）
  const wrongCount = history.filter((h) => h && h.correct === false).length;
  if (!reasons.length) {
    if (attempts < CONFIDENCE_SATURATION) reasons.push(`练习样本较少（${attempts} 题）`);
    if (wrongCount > 0) reasons.push(`累计答错 ${wrongCount} 题`);
  }

  // ⑥ 向先验收缩（样本越少越保守）。注意：已通过复习测验是最强客观证据，
  //    此时先验抬到 0.85，避免"只答两题就通过"被收缩成"一般"。
  const prior = passedReview ? 0.85 : PRIOR;
  const score = Math.round(((raw * attempts + prior * SHRINK_K) / (attempts + SHRINK_K)) * 1000) / 1000;
  const level = levelOf(score, attempts, passedReview);
  return finalize(raw, confidence, attempts, reasons, level, score);
}

function finalize(raw, confidence, attempts, reasons, level, scoreIn) {
  const score = typeof scoreIn === 'number' ? scoreIn : Math.round(raw * 1000) / 1000;
  return {
    score,
    raw: Math.round(raw * 1000) / 1000,
    confidence,
    level,
    label: LEVEL_LABEL[level] || '待评估',
    attempts,
    reasons,
  };
}

/** 掌握档位（学生可见用词，避免百分比） */
const LEVEL_LABEL = { weak: '薄弱', developing: '一般', proficient: '熟练', strong: '扎实' };

function levelOf(score, attempts, passedReview) {
  if (passedReview && score >= 0.8) return 'strong';
  if (attempts < 2) return score >= 0.5 ? 'developing' : 'weak';
  if (score >= 0.8) return 'strong';
  if (score >= 0.62) return 'proficient';
  if (score >= 0.4) return 'developing';
  return 'weak';
}

/**
 * 薄弱度评分（越高越该优先练/复习）：供 practiceTargets / recommend_next 排序。
 * 组成：掌握度越低越高 + 到期复习加分 + 最近答错加分 + 已掌握减分。
 */
function weaknessScore(rec, now = Date.now()) {
  if (!rec) return 0;
  const { score } = estimateMastery(rec, now);
  let w = (1 - score) * 100;
  const due = rec.review && rec.review.dueAt ? Date.parse(rec.review.dueAt) : NaN;
  if (Number.isFinite(due) && due <= now) w += 25;            // 到期该复习
  const wrong = (rec.quizHistory || []).filter((h) => h && h.correct === false).length;
  w += Math.min(wrong * 5, 25);                                // 历史错题
  const tail = (rec.quizHistory || []).slice(-3);
  if (tail.length >= 2 && tail.every((h) => h && h.correct === false)) w += 15; // 近期连错
  if (rec.assessment && rec.assessment.passed === true) w -= 20; // 已通过复习测验
  return Math.round(w * 100) / 100;
}

module.exports = { estimateMastery, weaknessScore, LEVEL_LABEL, RECENCY_DECAY, CONFIDENCE_SATURATION };
