'use strict';

/**
 * Reproducible Memory 2.0 benchmark.
 * Uses an isolated temporary SQLite database and synthetic fixtures only.
 * No learner production data or external model/API calls are required.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edupilot-memory-eval-'));
process.env.EDUOWL_DB = path.join(tempDir, 'memory-eval.db');
process.env.EMBED_PROVIDER = 'dashscope';
process.env.DASHSCOPE_API_KEY = '';

const store = require('../server/store/memoryStore');
const sessionStore = require('../server/store/sessionStore');
const memory = require('../server/agent/memory');
const metrics = require('../server/agent/memory-evaluation');

async function main() {
  const db = sessionStore.init();
  try {
    const currentSession = 'benchmark-user@python-intro~session-a';
    const otherSession = 'benchmark-user@ml-course~session-b';
    const relevantCurrent = 'Recurring confusion about recursion base cases';
    const relevantOther = 'Recurring confusion about regression assumptions';

    await store.ingestArchival(currentSession, [{
      type: 'pain',
      text: relevantCurrent,
      provenance: {
        sessionId: currentSession,
        turn: 3,
        quote: 'I repeatedly confuse recursion base cases',
        messageHash: 'synthetic-recursion-evidence',
      },
    }]);
    await store.ingestArchival(currentSession, [{
      type: 'preference',
      text: 'Prefers concise worked examples',
      provenance: {
        sessionId: currentSession,
        turn: 1,
        quote: 'I prefer concise worked examples',
        messageHash: 'synthetic-preference-evidence',
      },
    }], { scopeMode: 'uid' });
    await store.ingestArchival(otherSession, [{
      type: 'pain',
      text: relevantOther,
      provenance: {
        sessionId: otherSession,
        turn: 2,
        quote: 'I repeatedly confuse regression assumptions',
        messageHash: 'synthetic-regression-evidence',
      },
    }]);

    const currentResults = await store.searchArchival(
      currentSession, 'recursion base cases', { topK: 5 }
    );
    const currentRetrieval = metrics.evaluateRetrieval(currentResults, [relevantCurrent], 5);
    const currentScope = metrics.evaluateScope(currentResults, ['python-intro']);
    assert.equal(currentRetrieval.recallAtK, 1, 'Current-course relevant memory must be retrieved');
    assert.equal(currentScope.passed, true, 'Other-course memories must not leak into default retrieval');

    const crossCourseResults = await store.searchArchival(
      currentSession, 'regression assumptions', { topK: 5, includeOtherCourses: true }
    );
    const crossCourseRetrieval = metrics.evaluateRetrieval(crossCourseResults, [relevantOther], 5);
    assert.equal(crossCourseRetrieval.recallAtK, 1, 'Explicit cross-course retrieval must find the requested memory');

    const session = {
      id: currentSession,
      activeCourseId: 'python-intro',
      learning: { currentKpId: null, kps: {} },
    };
    memory.refreshStudentNote(session);
    const context = await memory.buildMemoryInjection(
      session, 'Explain recursion base cases', { agentId: 'learn' }
    );
    const contextQuality = metrics.evaluateContext(context, {
      maxTokens: 1050,
      forbiddenPhrases: ['regression assumptions'],
    });
    assert.equal(contextQuality.withinBudget, true, 'Learning context must fit its role budget');
    assert.equal(contextQuality.leakagePassed, true, 'Learning context must not contain other-course difficulties');

    const lifecycleRecords = store.listUserArchival(currentSession);
    const evidence = metrics.evaluateEvidenceCoverage(lifecycleRecords);
    assert.equal(evidence.coverage, 1, 'All benchmark memories must retain source evidence');

    const decisions = metrics.evaluateBinaryDecisions([
      { id: 'pattern-a', accepted: true },
      { id: 'pattern-b', accepted: true },
      { id: 'pattern-c', accepted: false },
    ], ['pattern-a', 'pattern-c']);
    assert.equal(decisions.truePositive, 1);
    assert.equal(decisions.falsePositive, 1);
    assert.equal(decisions.falseNegative, 1);
    assert.equal(decisions.f1, 0.5);

    const aggregate = metrics.aggregateRetrievalCases([currentRetrieval, crossCourseRetrieval]);
    assert.equal(aggregate.cases, 2);
    assert.equal(aggregate.recallAtK, 1);

    const report = {
      suite: 'EduPilot Memory 2.0',
      fixtureSource: 'synthetic; isolated temporary SQLite database',
      retrieval: {
        currentCourse: currentRetrieval,
        explicitCrossCourse: crossCourseRetrieval,
        aggregate,
      },
      scope: currentScope,
      context: contextQuality,
      evidenceCoverage: evidence,
      promotionDecisionExample: decisions,
      passed: true,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('[memory-eval] failed:', error);
  process.exitCode = 1;
});
