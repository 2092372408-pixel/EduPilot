/**
 * Evidence-based coding practice and independent transfer checks.
 *
 * All state lives under session.learning so the caller's session lock and save
 * operation cover the complete transition. The caller must serialize mutations.
 * Full problem specifications remain server-side; every response is a whitelist.
 * A transfer check is supplementary evidence, never a replacement for the
 * course's preview / learning / review progression rules.
 */
const { createHash, randomUUID } = require('crypto');
const { course } = require('../data/course');

const VERSION = 2;
const RULE_VERSION = 'learning-harness-2';
const { callCore } = require('../harness/python-core');
const MAX_CODE = 20000;
const MAX_VISIBLE_HISTORY = 20;
const MAX_RECENT_EVIDENCE = 50;
const sha = value => createHash('sha256').update(String(value)).digest('hex');
const iso = () => new Date().toISOString();
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const language = value => value === 'en' ? 'en' : 'zh';
const variants = () => require('../coding/variants');

const MESSAGES = {
  unsupported_course: ['诊断练习当前支持内置 Python 课程，请先切换课程。', 'Diagnostic practice currently supports the built-in Python course. Please switch courses.'],
  invalid_request: ['请求不完整，请刷新后重试。', 'The request is incomplete. Refresh and try again.'],
  invalid_family: ['未找到这个练习主题。', 'This practice topic is not available.'],
  stale_task: ['题目已切换或过期，请使用当前题目重新提交。', 'This task has changed or expired. Submit the current task instead.'],
  request_conflict: ['同一请求编号对应了不同内容，请重新操作。', 'This request ID was already used for different content. Start a new action.'],
  empty_code: ['请先填写代码再提交。', 'Enter your code before submitting.'],
  code_too_long: ['代码过长，请将本题代码控制在 20000 字符以内。', 'Please keep this solution within 20,000 characters.'],
  task_complete: ['本题已经完成，请进入新的验证题。', 'This task is complete. Continue with a new transfer check.'],
  practice_required: ['先完成当前练习，再用新题独立验证。', 'Complete this practice task before an independent transfer check.'],
  attempt_required: ['请先尝试当前题目，或请求提示。', 'Try the current task or request a hint first.'],
  validation_failed: ['新题未通过发布前检查，原有记录已保留，请稍后重试。', 'The new task did not pass its quality checks. Your existing work is preserved; please retry later.'],
  variant_exhausted: ['暂时无法生成未见的新题，请换个主题或稍后重试。', 'An unseen task could not be generated right now. Please choose another topic or retry later.'],
  grading_unavailable: ['代码验证暂时不可用，本次没有计入作答，请稍后重试。', 'Code verification is unavailable. This was not counted as an attempt; please retry later.'],
  invalid_grade: ['验证结果不完整，本次没有计入作答，请重试。', 'Verification returned an incomplete result. This was not counted as an attempt; please retry.'],
  hint_unavailable: ['这一级提示暂时不可用，请重试或检查已有反例。', 'This hint is unavailable. Please retry or examine the existing counterexample.'],
  unknown_diagnosis: ['现有执行结果不足以确定原因，请先比较失败输入的预期与实际结果。', 'The execution evidence does not establish a specific cause. Compare the expected and actual results for the failing input.'],
};

function message(key, lang) {
  const pair = MESSAGES[key] || MESSAGES.invalid_request;
  return pair[language(lang) === 'en' ? 1 : 0];
}

function supported(session) {
  return !!(session && session.activeCourseId === course.id && session.learning && session.learning.kps);
}

function stateOf(session, create = false) {
  if (!session?.learning) return null;
  let state = session.learning.learningLab;
  if (!state && create) {
    state = { version: VERSION, currentTaskId: null, tasks: [], requestLedger: {} };
    session.learning.learningLab = state;
  }
  return state || null;
}

function currentOf(state) {
  return state?.tasks?.find(task => task.id === state.currentTaskId) || null;
}

function assistanceOf(task) {
  const data = task?.assistance || {};
  return { ...data, state: ['known_none', 'assisted', 'unknown'].includes(data.state) ? data.state : 'unknown',
    hintsUsed: Number(data.hintsUsed) || 0, chatHelpCount: Number(data.chatHelpCount) || 0,
    answerExposed: data.answerExposed === true };
}

function recordHelp(session, { taskId, requestId, source = 'chat' } = {}) {
  const task = currentOf(stateOf(session));
  if (!task || task.id !== taskId) return { ok: false, errorCode: 'stale_task' };
  if (['passed', 'independent'].includes(task.status)) return { ok: true, changed: false };
  task.assistance = assistanceOf(task);
  const key = sha(String(requestId || randomUUID()));
  task.helpLedger ||= {};
  if (task.helpLedger[key]) return { ok: true, changed: false, duplicate: true };
  task.helpLedger[key] = { source, at: iso(), ruleVersion: RULE_VERSION };
  if (source === 'unknown') {
    if (task.assistance.state === 'known_none') task.assistance.state = 'unknown';
  } else {
    task.assistance.state = 'assisted';
    if (source === 'chat') task.assistance.chatHelpCount++;
  }
  task.updatedAt = iso();
  return { ok: true, changed: true, assistance: clone(task.assistance) };
}

function chatContext(session, taskId) {
  const task = currentOf(stateOf(session));
  if (!task || task.id !== taskId) return null;
  const safe = publicTask(task);
  return { mode: 'learning_lab', taskId: task.id, taskVersion: task.version || 1, kpId: task.kpId,
    problemId: task.id, problemTitle: safe.title, problemDescription: safe.prompt,
    code: safe.currentCode, gradeFeedback: safe.result, assistance: assistanceOf(task),
    submitted: safe.status === 'passed' || safe.status === 'independent', ruleVersion: task.ruleVersion || 'legacy-1' };
}

function publicFamily(family, lang) {
  const en = language(lang) === 'en';
  return {
    id: family.id, kpId: family.kpId,
    title: en ? family.titleEn || family.title : family.title,
    description: en ? family.descriptionEn || family.description : family.description,
  };
}

function publicEvidence(evidence) {
  if (!evidence || evidence.kind !== 'independent_transfer') return null;
  return {
    id: evidence.id, taskId: evidence.taskId, kpId: evidence.kpId,
    familyId: evidence.familyId,
    templateVersion: evidence.templateVersion, at: evidence.at,
    kind: 'independent_transfer', verified: evidence.verified === true,
    attempt: evidence.attempt, hintsUsed: evidence.hintsUsed,
    answerExposed: evidence.answerExposed === true,
    passed: evidence.passed, total: evidence.total,
    ruleVersion: evidence.ruleVersion || 'legacy-1', assistanceState: evidence.assistanceState || 'unknown',
  };
}

function evidenceOf(learning) {
  return Object.values(learning?.kps || {})
    .flatMap(rec => Array.isArray(rec.transferEvidence) ? rec.transferEvidence : [])
    .map(publicEvidence).filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Expected values are revealed only for a failed check, after an actual attempt.
// Reference solutions, judge expressions and validation mutants never cross this boundary.
function publicFailure(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const out = {};
  for (const key of ['id', 'checkId', 'kind', 'input', 'expected', 'actual', 'message', 'line', 'constraint']) {
    if (evidence[key] !== undefined) out[key] = clone(evidence[key]);
  }
  if (typeof evidence.stdout === 'string') out.stdout = evidence.stdout.slice(0, 1500);
  if (evidence.exception && typeof evidence.exception === 'object') {
    out.exception = {
      type: String(evidence.exception.type || '').slice(0, 100),
      message: String(evidence.exception.message || '').slice(0, 1000),
    };
  }
  return out;
}

function publicResult(result, lang) {
  if (!result) return null;
  const results = (Array.isArray(result.results) ? result.results : []).map(check => ({
    id: check.id, desc: String(check.desc || ''), pass: check.pass === true,
    ...(check.pass === true ? {} : {
      output: String(check.output || '').slice(0, 1500),
      evidence: publicFailure(check.evidence),
    }),
  }));
  const diagnosis = result.diagnosis || {};
  return {
    passed: Number(result.passed) || 0, total: Number(result.total) || 0,
    objectiveScore: Number.isFinite(result.objectiveScore) ? result.objectiveScore : null,
    verified: result.verified === true,
    results,
    failureEvidence: results.filter(check => !check.pass && check.evidence).map(check => ({ checkId: check.id, desc: check.desc, ...check.evidence })),
    diagnosisId: String(result.diagnosisId || diagnosis.id || 'unknown'),
    diagnosis: {
      id: String(result.diagnosisId || diagnosis.id || 'unknown'),
      confidence: diagnosis.confidence === 'certain' ? 'certain' : 'unknown',
      summary: String(diagnosis.summary || message('unknown_diagnosis', lang)),
      evidence: Array.isArray(diagnosis.evidence) ? diagnosis.evidence.filter(id => typeof id === 'string') : [],
    },
    ...(result.error ? { error: String(result.error).slice(0, 1000) } : {}),
    ...(result.rejected ? { rejected: true } : {}),
    ...(result.timeout ? { timeout: true } : {}),
  };
}

function canNext(task) {
  if (!task) return false;
  if (task.purpose === 'practice') return task.status === 'passed';
  return task.attempts.length > 0 || task.assistance.hintsUsed > 0;
}

function publicTask(task, interfaceLang) {
  if (!task) return null;
  const problem = variants().publicVariant(task.problem);
  const completed = task.status === 'passed' || task.status === 'independent';
  const result = publicResult(task.result, task.lang);
  const languageNotice = interfaceLang && language(interfaceLang) !== task.lang
    ? language(interfaceLang) === 'en'
      ? 'This task was created in Chinese. New tasks will use the current interface language.'
      : '这道题使用英文；新题将使用当前界面语言。'
    : null;
  return {
    id: task.id, taskId: task.id, familyId: task.familyId, kpId: task.kpId,
    purpose: task.purpose, phase: task.purpose, lang: task.lang,
    templateVersion: task.templateVersion, languageNotice,
    problem, title: problem.title, prompt: problem.description,
    starterCode: problem.starterCode, publicExamples: problem.publicExamples || [],
    constraints: problem.constraints || [], currentCode: task.currentCode,
    attempts: task.attempts.length,
    assistance: assistanceOf(task), taskVersion: task.version || 1, ruleVersion: task.ruleVersion || 'legacy-1',
    hintsUsed: task.assistance.hintsUsed,
    visibleHints: task.hints.map(hint => ({ level: hint.level, text: hint.text, at: hint.at })),
    lastResult: result, result, status: task.status,
    canRequestHint: !completed && task.hints.length < 3,
    canNext: canNext(task),
    nextAction: canNext(task) ? (task.purpose === 'practice' ? 'transfer' : 'retry_transfer') : null,
    independentEligible: task.purpose === 'transfer' && task.wasUnseen === true
      && task.validation?.ok === true && task.attempts.length === 0
      && assistanceOf(task).state === 'known_none' && task.assistance.hintsUsed === 0 && !task.assistance.answerExposed,
    independentVerified: task.status === 'independent',
    attemptHistory: task.attempts.slice(-10).map(attempt => ({
      id: attempt.id, number: attempt.number, at: attempt.at,
      firstSubmission: attempt.firstSubmission, repeatedCode: attempt.repeatedCode,
      hintsUsed: attempt.assistance.hintsUsed, answerExposed: attempt.assistance.answerExposed,
      assistanceState: attempt.assistance.state || 'unknown',
      correct: attempt.correct, independent: attempt.independent,
      passed: attempt.result.passed, total: attempt.result.total,
    })),
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
}

function publicHistory(task) {
  const complete = task.status === 'passed' || task.status === 'independent';
  return {
    taskId: task.id, familyId: task.familyId, title: task.problem.title,
    purpose: task.purpose, lang: task.lang, status: task.status, attempts: task.attempts.length,
    hintsUsed: task.assistance.hintsUsed, answerExposed: task.assistance.answerExposed,
    assistanceState: assistanceOf(task).state,
    outcome: task.status === 'independent' ? 'independent'
      : complete && (task.attempts.length > 1 || assistanceOf(task).state !== 'known_none') ? 'corrected'
        : complete ? 'passed' : 'incomplete',
    passed: task.result?.passed || 0, total: task.result?.total || 0,
    createdAt: task.createdAt, completedAt: task.completedAt || null, updatedAt: task.updatedAt,
  };
}

function publicState(learning, interfaceLang) {
  const state = learning?.learningLab;
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const evidence = evidenceOf(learning);
  return {
    currentTask: publicTask(currentOf(state), interfaceLang),
    history: tasks.filter(task => task.id !== state?.currentTaskId).slice(-MAX_VISIBLE_HISTORY).reverse().map(publicHistory),
    summary: {
      tasks: tasks.length,
      submissions: tasks.reduce((sum, task) => sum + task.attempts.length, 0),
      corrected: tasks.filter(task => publicHistory(task).outcome === 'corrected').length,
      independent: evidence.length,
      hintsUsed: tasks.reduce((sum, task) => sum + task.assistance.hintsUsed, 0),
      validatedTasks: tasks.filter(task => task.validation?.ok === true).length,
      lastIndependentAt: evidence[0]?.at || null,
    },
    evidence: evidence.slice(0, MAX_VISIBLE_HISTORY),
  };
}

function getOverview(session, opts = {}) {
  const available = supported(session);
  const families = available ? variants().listFamilies()
    .filter(family => session.learning.kps[family.kpId])
    .map(family => publicFamily(family, opts.lang)) : [];
  return {
    ok: true, supported: available,
    sessionId: session?.id || null, courseId: session?.activeCourseId || null,
    families, ...publicState(session?.learning, opts.lang),
  };
}

// Use this when an API needs to return the broader learning object.
function scrubLearning(learning, opts = {}) {
  if (!learning || typeof learning !== 'object') return learning;
  const out = { ...learning };
  if (out.kps && typeof out.kps === 'object') {
    out.kps = Object.fromEntries(Object.entries(out.kps).map(([kpId, rec]) => {
      const safe = { ...rec };
      if (Array.isArray(rec.transferEvidence)) safe.transferEvidence = rec.transferEvidence.map(publicEvidence).filter(Boolean);
      if (Array.isArray(rec.practiceEvidence)) safe.practiceEvidence = rec.practiceEvidence.map(evidence => ({
        id: evidence.id, taskId: evidence.taskId, kpId: evidence.kpId, familyId: evidence.familyId,
        templateVersion: evidence.templateVersion, at: evidence.at, kind: evidence.kind,
        verified: evidence.verified === true, attempt: evidence.attempt,
        hintsUsed: evidence.hintsUsed, answerExposed: evidence.answerExposed === true,
        correct: evidence.correct === true, independent: evidence.independent === true,
        firstSubmission: evidence.firstSubmission === true, repeatedCode: evidence.repeatedCode === true,
        passed: evidence.passed, total: evidence.total,
        ruleVersion: evidence.ruleVersion || 'legacy-1', assistanceState: evidence.assistanceState || 'unknown',
      }));
      return [kpId, safe];
    }));
  }
  if (out.learningLab) out.learningLab = { version: VERSION, ...publicState(learning, opts.lang) };
  return out;
}

function failure(session, errorCode, lang) {
  return { ...getOverview(session, { lang }), ok: false, errorCode, error: message(errorCode, lang) };
}

function beginOperation(session, input, action) {
  const lang = language(input?.lang);
  if (!supported(session)) return { response: failure(session, 'unsupported_course', lang) };
  const requestId = input && input.requestId;
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 120 || /[\x00-\x1f]/.test(requestId)) {
    return { response: failure(session, 'invalid_request', lang) };
  }
  const digest = sha(JSON.stringify({
    action, familyId: input.familyId ?? null, taskId: input.taskId ?? null,
    ...(action === 'submit' ? { code: input.code } : {}),
  }));
  const state = stateOf(session, true);
  const requestKey = sha(requestId);
  const previous = state.requestLedger[requestKey];
  if (previous) {
    if (previous.digest !== digest) return { response: failure(session, 'request_conflict', lang) };
    return { response: { ...getOverview(session, { lang }), duplicate: true, operation: clone(previous.operation) } };
  }
  return { state, requestKey, digest, lang, action };
}

function finishOperation(session, operation, details) {
  const result = { type: operation.action, ...details };
  operation.state.requestLedger[operation.requestKey] = { digest: operation.digest, operation: result, at: iso() };
  return { ...getOverview(session, { lang: operation.lang }), operation: clone(result) };
}

function activeTask(operation, input) {
  const task = currentOf(operation.state);
  return task && typeof input.taskId === 'string' && input.taskId === task.id ? task : null;
}

function fingerprint(problem) {
  return String(problem.variantKey || sha(JSON.stringify({
    familyId: problem.familyId, description: problem.description,
    starterCode: problem.starterCode, examples: problem.publicExamples,
    constraints: problem.constraints,
  })));
}

async function createTask(session, operation, familyId, purpose) {
  const family = variants().listFamilies().find(item => item.id === familyId);
  if (!family || !session.learning.kps[family.kpId]) return { errorCode: 'invalid_family' };
  const seen = new Set(operation.state.tasks.map(task => task.variantKey));
  let problem;
  try {
    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = variants().createVariant(familyId, randomUUID(), { purpose, lang: operation.lang });
      if (!candidate || candidate.familyId !== familyId || candidate.kpId !== family.kpId) return { errorCode: 'validation_failed' };
      if (!seen.has(fingerprint(candidate))) { problem = candidate; break; }
    }
    if (!problem) return { errorCode: 'variant_exhausted' };
    const validation = await variants().validateVariant(problem);
    if (!validation?.ok || validation.referenceTotal <= 0
      || validation.referencePassed !== validation.referenceTotal
      || validation.mutantsTotal <= 0 || validation.mutantsRejected !== validation.mutantsTotal) {
      return { errorCode: 'validation_failed' };
    }
    const at = iso();
    return { task: {
      id: randomUUID(), familyId, kpId: family.kpId, purpose, lang: operation.lang,
      version: 1, ruleVersion: RULE_VERSION,
      seed: String(problem.seed), templateVersion: problem.templateVersion,
      variantKey: fingerprint(problem), wasUnseen: true,
      problem: clone(problem), validation: clone(validation),
      status: 'ready', currentCode: String(problem.starterCode || ''),
      attempts: [], hints: [], assistance: { state: 'known_none', hintsUsed: 0, chatHelpCount: 0, answerExposed: false }, helpLedger: {},
      result: null, createdAt: at, updatedAt: at,
    } };
  } catch (_) {
    return { errorCode: 'validation_failed' };
  }
}

function activate(session, operation, task) {
  const previous = currentOf(operation.state);
  if (previous) previous.archivedAt = iso();
  operation.state.tasks.push(task);
  operation.state.currentTaskId = task.id;
  session.learning.currentKpId = task.kpId;
}

async function startOrReset(session, input = {}, action) {
  const operation = beginOperation(session, input, action);
  if (operation.response) return operation.response;
  const made = await createTask(session, operation, input.familyId, 'practice');
  if (made.errorCode) return failure(session, made.errorCode, operation.lang);
  activate(session, operation, made.task);
  return finishOperation(session, operation, { taskId: made.task.id });
}

function start(session, input = {}) { return startOrReset(session, input, 'start'); }
function reset(session, input = {}) { return startOrReset(session, input, 'reset'); }

function recordEvidence(session, task, attempt) {
  const rec = session.learning.kps[task.kpId];
  const base = {
    id: attempt.id, taskId: task.id, kpId: task.kpId, familyId: task.familyId,
    seed: task.seed, templateVersion: task.templateVersion, at: attempt.at,
    verified: attempt.result.verified === true, attempt: attempt.number,
    hintsUsed: attempt.assistance.hintsUsed, answerExposed: attempt.assistance.answerExposed,
    passed: attempt.result.passed, total: attempt.result.total, codeDigest: attempt.codeDigest,
    ruleVersion: RULE_VERSION, taskVersion: task.version || 1,
    assistanceState: attempt.assistance.state, chatHelpCount: attempt.assistance.chatHelpCount || 0,
  };
  const practice = {
    ...base, kind: 'coding_attempt', correct: attempt.correct,
    firstSubmission: attempt.firstSubmission, repeatedCode: attempt.repeatedCode,
    independent: attempt.independent,
  };
  rec.practiceEvidence = [...(Array.isArray(rec.practiceEvidence) ? rec.practiceEvidence : []), practice].slice(-MAX_RECENT_EVIDENCE);
  if (attempt.independent) {
    const evidence = { ...base, kind: 'independent_transfer' };
    rec.transferEvidence = [...(Array.isArray(rec.transferEvidence) ? rec.transferEvidence : []), evidence];
    task.evidenceId = evidence.id;
  }
  rec.lastActivity = attempt.at;
  // No phase / checks / assessment / cumulative quiz score mutation here.
}

async function submit(session, input = {}) {
  const operation = beginOperation(session, input, 'submit');
  if (operation.response) return operation.response;
  const task = activeTask(operation, input);
  if (!task) return failure(session, 'stale_task', operation.lang);
  if (task.status === 'passed' || task.status === 'independent') return failure(session, 'task_complete', operation.lang);
  if (typeof input.code !== 'string' || !input.code.trim()) return failure(session, 'empty_code', operation.lang);
  if (input.code.length > MAX_CODE) return failure(session, 'code_too_long', operation.lang);
  let grade;
  try {
    grade = await require('../coding/grader').gradeProblem(task.problem, input.code, { review: false });
  } catch (_) {
    return failure(session, 'grading_unavailable', operation.lang);
  }
  if (!grade || grade.unavailable) return failure(session, 'grading_unavailable', operation.lang);
  const valid = !grade.error && Number.isInteger(grade.passed) && Number.isInteger(grade.total)
    && grade.total > 0 && grade.passed >= 0 && grade.passed <= grade.total
    && Array.isArray(grade.results) && grade.results.length === grade.total
    && grade.results.every(check => typeof check.pass === 'boolean')
    && grade.results.filter(check => check.pass).length === grade.passed;
  if (!valid && !grade.rejected && !grade.timeout) return failure(session, 'invalid_grade', operation.lang);
  const result = publicResult({ ...grade, verified: valid }, task.lang);
  const at = iso();
  const codeDigest = sha(input.code);
  const correct = valid && grade.passed === grade.total;
  task.assistance = assistanceOf(task);
  const policy = callCore('eligibility', { task: { purpose: task.purpose, wasUnseen: task.wasUnseen, validation: { ok: task.validation?.ok === true } },
    attemptNumber: task.attempts.length + 1, result, assistance: task.assistance });
  if (!policy.ok) return failure(session, 'invalid_grade', operation.lang);
  const independent = policy.independent === true;
  const attempt = {
    id: randomUUID(), number: task.attempts.length + 1, at, code: input.code, codeDigest,
    firstSubmission: task.attempts.length === 0,
    repeatedCode: task.attempts.some(previous => previous.codeDigest === codeDigest),
    assistance: clone(task.assistance), correct, independent, result,
  };
  task.attempts.push(attempt);
  task.currentCode = input.code;
  task.result = result;
  task.status = independent ? 'independent' : correct ? 'passed' : 'needs_revision';
  task.updatedAt = at;
  if (correct) task.completedAt = at;
  recordEvidence(session, task, attempt);
  return finishOperation(session, operation, { taskId: task.id, attemptId: attempt.id, correct, independent });
}

async function hint(session, input = {}) {
  const operation = beginOperation(session, input, 'hint');
  if (operation.response) return operation.response;
  const task = activeTask(operation, input);
  if (!task) return failure(session, 'stale_task', operation.lang);
  if (task.status === 'passed' || task.status === 'independent') return failure(session, 'task_complete', operation.lang);
  if (task.hints.length >= 3) return finishOperation(session, operation, { taskId: task.id, hintLimitReached: true });
  let hints;
  try {
    hints = await variants().getHints(task.problem, task.result?.diagnosisId || 'unknown', task.lang);
  } catch (_) {
    return failure(session, 'hint_unavailable', operation.lang);
  }
  const entry = Array.isArray(hints) ? hints[task.hints.length] : null;
  const text = typeof entry === 'string' ? entry : entry?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 2000
    || (task.problem.referenceCode?.trim() && text.includes(task.problem.referenceCode.trim()))) {
    return failure(session, 'hint_unavailable', operation.lang);
  }
  const at = iso();
  task.hints.push({ level: task.hints.length + 1, text, at });
  task.assistance.hintsUsed = task.hints.length;
  task.assistance.state = 'assisted';
  task.assistance.chatHelpCount ||= 0;
  if (entry && typeof entry === 'object' && entry.revealsAnswer === true) task.assistance.answerExposed = true;
  task.updatedAt = at;
  return finishOperation(session, operation, { taskId: task.id, hintLevel: task.hints.length });
}

async function next(session, input = {}) {
  const operation = beginOperation(session, input, 'next');
  if (operation.response) return operation.response;
  const task = activeTask(operation, input);
  if (!task) return failure(session, 'stale_task', operation.lang);
  if (!canNext(task)) return failure(session, task.purpose === 'practice' ? 'practice_required' : 'attempt_required', operation.lang);
  const made = await createTask(session, operation, task.familyId, 'transfer');
  if (made.errorCode) return failure(session, made.errorCode, operation.lang);
  activate(session, operation, made.task);
  return finishOperation(session, operation, { taskId: made.task.id, previousTaskId: task.id });
}

module.exports = { getOverview, start, submit, hint, next, reset, scrubLearning, recordHelp, chatContext, assistanceOf, RULE_VERSION };
