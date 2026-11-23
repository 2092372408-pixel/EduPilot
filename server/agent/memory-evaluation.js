'use strict';

/**
 * Pure evaluation metrics for the memory retrieval and context pipeline.
 * This module contains no user-data fixtures and performs no persistence.
 * Callers provide synthetic or explicitly approved evaluation cases.
 */

function itemKey(item) {
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (!item || typeof item !== 'object') return '';
  if (item.id != null) return String(item.id);
  if (item.text != null) return String(item.text);
  return '';
}

function evaluateRetrieval(results, relevantItems, k = 5) {
  const limit = Math.max(1, Math.min(100, Number(k) || 5));
  // Deduplicate while preserving rank: duplicate results must not inflate retrieval quality.
  const ranked = [...new Set((Array.isArray(results) ? results : []).map(itemKey).filter(Boolean))].slice(0, limit);
  const relevant = new Set((Array.isArray(relevantItems) ? relevantItems : []).map(itemKey).filter(Boolean));
  const hits = ranked.filter(key => relevant.has(key));
  // Conventional Precision@K uses K as the denominator, including unfilled result slots.
  const precisionAtK = hits.length / limit;
  const recallAtK = relevant.size ? new Set(hits).size / relevant.size : 0;
  const firstRelevantRank = ranked.findIndex(key => relevant.has(key));
  const reciprocalRank = firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0;

  let dcg = 0;
  ranked.forEach((key, index) => {
    if (relevant.has(key)) dcg += 1 / Math.log2(index + 2);
  });
  let idealDcg = 0;
  for (let index = 0; index < Math.min(relevant.size, limit); index++) {
    idealDcg += 1 / Math.log2(index + 2);
  }

  return {
    precisionAtK,
    recallAtK,
    reciprocalRank,
    ndcgAtK: idealDcg ? dcg / idealDcg : 0,
    retrieved: ranked.length,
    relevant: relevant.size,
    hits: new Set(hits).size,
    k: limit,
  };
}

function evaluateScope(results, allowedCourseIds = []) {
  const allowed = new Set((Array.isArray(allowedCourseIds) ? allowedCourseIds : []).map(String));
  const leaked = (Array.isArray(results) ? results : []).filter(item => {
    const courseId = item && item.sourceCourseId;
    return courseId != null && String(courseId) && !allowed.has(String(courseId));
  });
  return {
    passed: leaked.length === 0,
    leakedCount: leaked.length,
    leakedCourseIds: [...new Set(leaked.map(item => String(item.sourceCourseId)))],
  };
}

function estimateTokens(value) {
  // Conservative approximation for mixed Chinese/English text; no provider tokenizer required.
  return Math.ceil(String(value || '').length / 2.2);
}

function evaluateContext(context, options = {}) {
  const text = String(context || '');
  const estimatedTokens = estimateTokens(text);
  const maxTokens = Math.max(1, Number(options.maxTokens) || 1);
  const forbiddenPhrases = (Array.isArray(options.forbiddenPhrases) ? options.forbiddenPhrases : [])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const leakage = forbiddenPhrases.filter(phrase => text.includes(phrase));
  return {
    estimatedTokens,
    maxTokens,
    withinBudget: estimatedTokens <= maxTokens,
    leakagePassed: leakage.length === 0,
    leakage,
  };
}

function evaluateEvidenceCoverage(records) {
  const rows = Array.isArray(records) ? records : [];
  const covered = rows.filter(record => {
    const provenance = record && record.provenance;
    return !!(provenance && (
      (typeof provenance.quote === 'string' && provenance.quote.trim() && provenance.messageHash)
      || (Array.isArray(provenance.eventIds) && provenance.eventIds.length > 0)
      || (Array.isArray(provenance.evidence) && provenance.evidence.length > 0)
    ));
  }).length;
  return {
    total: rows.length,
    covered,
    coverage: rows.length ? covered / rows.length : 1,
  };
}

function evaluateLifecycle(memory, expected = {}) {
  const checks = {
    statusMatches: expected.status == null || memory?.status === expected.status,
    versionMatches: expected.version == null || Number(memory?.version) === Number(expected.version),
    hasEvidence: expected.requireEvidence === false || evaluateEvidenceCoverage([memory]).coverage === 1,
    supersedesMatches: expected.supersedesId == null || memory?.supersedesId === expected.supersedesId,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function evaluateBinaryDecisions(predictions, expectedPositiveIds = []) {
  const expected = new Set((Array.isArray(expectedPositiveIds) ? expectedPositiveIds : []).map(itemKey).filter(Boolean));
  const predicted = new Set((Array.isArray(predictions) ? predictions : [])
    .filter(item => item && item.accepted === true)
    .map(itemKey).filter(Boolean));
  const universe = new Set([
    ...expected,
    ...(Array.isArray(predictions) ? predictions : []).map(itemKey).filter(Boolean),
  ]);
  let truePositive = 0;
  for (const id of predicted) if (expected.has(id)) truePositive++;
  const falsePositive = predicted.size - truePositive;
  const falseNegative = expected.size - truePositive;
  const trueNegative = Math.max(0, universe.size - truePositive - falsePositive - falseNegative);
  const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 0;
  const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 0;
  return {
    truePositive, falsePositive, falseNegative, trueNegative,
    precision, recall,
    f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
  };
}

function aggregateRetrievalCases(cases) {
  const rows = (Array.isArray(cases) ? cases : []).filter(Boolean);
  if (!rows.length) return { cases: 0, precisionAtK: 0, recallAtK: 0, reciprocalRank: 0, ndcgAtK: 0 };
  const mean = key => rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0) / rows.length;
  return {
    cases: rows.length,
    precisionAtK: mean('precisionAtK'),
    recallAtK: mean('recallAtK'),
    reciprocalRank: mean('reciprocalRank'),
    ndcgAtK: mean('ndcgAtK'),
  };
}

module.exports = {
  evaluateRetrieval,
  evaluateScope,
  estimateTokens,
  evaluateContext,
  evaluateEvidenceCoverage,
  evaluateLifecycle,
  evaluateBinaryDecisions,
  aggregateRetrievalCases,
};
