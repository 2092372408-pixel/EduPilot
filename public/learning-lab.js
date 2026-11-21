/* Diagnostic practice. The server owns grading, assistance and evidence eligibility. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const uid = localStorage.getItem('eduowl_uid') || ('demo-' + Date.now());
  localStorage.setItem('eduowl_uid', uid);
  const courseId = params.get('course') || localStorage.getItem('eduowl_course') || 'python-intro';
  const sessionId = uid + '@' + courseId;
  const pendingKey = 'eduowl_lab_pending:' + sessionId;
  const draftPrefix = 'eduowl_lab_draft:' + sessionId + ':';
  const lang = () => window.eduLanguage?.() === 'en' ? 'en' : 'zh';
  const state = {
    overview: null, selectedFamily: 'parity', selectedExplicitly: false,
    busy: false, loading: true, pending: null, retry: null,
    revision: 0, renderedTaskId: null, refreshAfterRequest: false, active: true,
  };

  const words = {
    zh: {
      brandSub: '把理解变成独立完成', back: '返回对话', course: 'PYTHON 编程入门',
      title: '诊断练习', subtitle: '找到卡点，再用一道新题确认理解。',
      available: '这组练习可直接使用', retry: '重试', loading: '正在恢复练习…',
      unsupportedTitle: '从 Python 基础开始',
      unsupportedText: '诊断练习目前支持 Python 编程入门的分支、循环和函数。练习记录会保存在这门课程中。',
      openPython: '进入 Python 诊断练习', startLabel: '从一小段代码开始', start: '开始练习',
      welcomeStep1: '先自己试一试', welcomeStep1Detail: '用一段短代码完成明确的小任务。',
      welcomeStep2: '找到具体卡点', welcomeStep2Detail: '看真实运行结果，按需要获取提示。',
      welcomeStep3: '再独立完成新题', welcomeStep3Detail: '换一个问题，把理解变成新的作答证据。',
      stepPractice: '先做练习', stepDiagnose: '定位卡点', stepTransfer: '独立验证',
      restart: '换一道练习', examples: '公开样例', yourCode: '你的代码',
      draftSaved: '草稿自动保存在此设备', draftUnavailable: '草稿暂未保存，请保留当前页面',
      shortcut: 'Tab 缩进 · Ctrl / ⌘ + Enter 提交', submit: '提交检查', hint: '给我一点提示',
      editorAccess: '按 Tab 插入缩进；按 Shift + Tab 离开代码编辑区。',
      nextHint: '再给一点提示', noMoreHints: '提示已全部展开', allChecks: '查看各项检查',
      hintsTitle: '一步一步来', records: '独立作答记录',
      recordsDetail: '保留首次独立通过新题的证据，供后续复习参考。',
      footer: '代码会实际运行检查。内置提示也可直接使用。',
      topicsLabel: '练习主题', progressLabel: '练习进度', placeholder: '# 在这里补全代码',
      practice: '初练', transfer: '独立验证', assisted: '使用了提示', noHint: '尚未使用提示',
      completed: '本题已完成', practiceNote: '先试着完成代码。遇到困难时，可以提交查看结果，或按需展开提示。',
      transferNote: '新题首次提交、未使用提示并通过全部检查，会留下独立作答记录。使用提示后，可以再换新题验证。',
      assistedNote: '本题已使用提示，会作为辅助练习。完成后可换一道新题，再独立验证。',
      retryTransferNote: '这次可以继续修改代码。完成后，再用一道新的题目独立验证。',
      working: '正在检查代码…', opening: '正在准备练习…', gettingHint: '正在打开提示…',
      checked: '已检查', attempt: '第 {n} 次提交', noCode: '先补全代码，再提交检查。',
      passedTitle: '这段代码通过了检查', passedSubtitle: '试试将刚才的理解用到一个新问题。',
      independentTitle: '首次独立通过，已记录', independentSubtitle: '这道新题的首次作答通过了全部检查。',
      reviseTitle: '从这个结果继续看', reviseSubtitle: '下面是最近一次提交代码的实际运行结果。',
      errorTitle: '代码暂时未能完成运行', errorSubtitle: '先看看下面的错误信息，修改后再提交。',
      count: '{passed} / {total}', counterexample: '一个值得检查的输入', input: '输入',
      expected: '期望结果', actual: '你的结果', noOutput: '没有返回结果', check: '检查 {n}',
      printed: '屏幕输出', constraintFail: '这一项题目要求还未满足，请对照要求检查代码。',
      hintsCount: '已展开 {n} 条', hintNote: '提示会保留在本题记录中。你仍可以在新题中独立完成。',
      nextTitle: '接下来，换一个新问题', nextText: '把刚才的思路带到新题中。这次先自己完成，再提交检查。',
      nextLabel: '开始独立验证',
      correctedTitle: '已经改对，再独立试一次', correctedText: '本题包含了提示或多次尝试。下一题会重新开始，给你一次独立完成的机会。',
      correctedLabel: '换新题独立验证',
      finishedTitle: '这次独立完成，有迹可循', finishedText: '本次记录已保存。可以继续巩固，也可以选择另一个主题。',
      finishedLabel: '继续巩固', evidenceBadge: '首次独立通过新题', firstAttempt: '首次提交',
      withoutHints: '未用提示', checksPassed: '{passed} 项检查通过', evidenceCount: '{n} 条记录',
      loadError: '暂时没有加载到练习', loadErrorDetail: '请检查连接后重试，你的已提交记录会保留。',
      uncertainError: '这次操作的结果还未确认', uncertainDetail: '代码已保留。重试会继续确认这次操作，不会重复记录一次提交。',
      restoredPending: '上次操作还没有确认完成，可以继续重试。',
      operationError: '这次操作没有完成', retryOperation: '重试这次操作', refresh: '刷新状态',
      network: '连接暂时不可用，请稍后重试。', badResponse: '服务返回了无法读取的结果，请稍后重试。',
      timedOut: '等待结果超时。代码已保留，可以重试这次操作。',
      completeShort: '已完成检查', pendingShort: '等待确认操作结果', notRun: '暂时无法运行代码。',
      welcomeDefault: '用一个小任务检查理解。遇到卡点时，查看真实结果并逐步修正。',
    },
    en: {
      brandSub: 'Turn understanding into independent work', back: 'Back to chat', course: 'PYTHON FOUNDATIONS',
      title: 'Diagnostic practice', subtitle: 'Find the sticking point. Then try a fresh problem on your own.',
      available: 'Ready to use', retry: 'Retry', loading: 'Restoring your practice…',
      unsupportedTitle: 'Start with Python foundations',
      unsupportedText: 'Diagnostic practice currently covers branches, loops and functions in Python Foundations. Your practice records stay with that course.',
      openPython: 'Open Python practice', startLabel: 'START WITH A FEW LINES OF CODE', start: 'Start practicing',
      welcomeStep1: 'Try it yourself', welcomeStep1Detail: 'Write a short program for one clear task.',
      welcomeStep2: 'Find the sticking point', welcomeStep2Detail: 'Inspect real results and reveal hints when needed.',
      welcomeStep3: 'Try a fresh problem', welcomeStep3Detail: 'Check your understanding with a new, independent attempt.',
      stepPractice: 'Practice', stepDiagnose: 'Find the issue', stepTransfer: 'Try independently',
      restart: 'New practice problem', examples: 'Public examples', yourCode: 'Your code',
      draftSaved: 'Draft saved on this device', draftUnavailable: 'Draft could not be saved; keep this page open',
      shortcut: 'Tab to indent · Ctrl / ⌘ + Enter to submit', submit: 'Check my code', hint: 'Give me a hint',
      editorAccess: 'Press Tab to indent. Press Shift + Tab to leave the code editor.',
      nextHint: 'Another hint', noMoreHints: 'All hints revealed', allChecks: 'View individual checks',
      hintsTitle: 'One step at a time', records: 'Independent attempts',
      recordsDetail: 'First-attempt successes on fresh problems, saved for future review.',
      footer: 'Your code is run and checked. Built-in hints are ready to use.',
      topicsLabel: 'Practice topics', progressLabel: 'Practice progress', placeholder: '# Complete your code here',
      practice: 'Practice', transfer: 'Independent attempt', assisted: 'Hint used', noHint: 'No hints used',
      completed: 'Problem completed', practiceNote: 'Try completing the code first. You can check the results or reveal a hint whenever you need one.',
      transferNote: 'Pass all checks on your first submission without hints to record an independent attempt. If you use a hint, you can try a fresh problem afterward.',
      assistedNote: 'A hint has been used, so this is assisted practice. Finish this problem, then try a new one independently.',
      retryTransferNote: 'Keep refining your code. After completing this problem, you can try a fresh one independently.',
      working: 'Checking your code…', opening: 'Preparing your practice…', gettingHint: 'Opening a hint…',
      checked: 'Checked', attempt: 'Submission {n}', noCode: 'Complete your code before submitting.',
      passedTitle: 'Your code passed the checks', passedSubtitle: 'Try applying the same idea to a new problem.',
      independentTitle: 'Independent success recorded', independentSubtitle: 'Your first attempt at this new problem passed every check.',
      reviseTitle: 'Take a closer look at this result', reviseSubtitle: 'These are the results of your most recent submission.',
      errorTitle: 'The code could not finish running', errorSubtitle: 'Review the error below, then edit your code and try again.',
      count: '{passed} / {total}', counterexample: 'An input worth checking', input: 'Input',
      expected: 'Expected result', actual: 'Your result', noOutput: 'No value returned', check: 'Check {n}',
      printed: 'Printed output', constraintFail: 'This requirement is not met yet. Compare your code with the task requirements.',
      hintsCount: '{n} hints revealed', hintNote: 'Hints are recorded for this problem. A fresh problem gives you another independent attempt.',
      nextTitle: 'Now try a fresh problem', nextText: 'Apply the same idea in a new task. Try it yourself before checking the result.',
      nextLabel: 'Try independently',
      correctedTitle: 'You fixed it. Try it independently.', correctedText: 'This problem included hints or multiple attempts. A fresh problem gives you a new opportunity to work on your own.',
      correctedLabel: 'Try a fresh problem',
      finishedTitle: 'An independent attempt, with evidence', finishedText: 'Your result is saved. Keep practicing or choose another topic.',
      finishedLabel: 'Keep practicing', evidenceBadge: 'First-attempt success on a new problem', firstAttempt: 'First submission',
      withoutHints: 'No hints used', checksPassed: '{passed} checks passed', evidenceCount: '{n} records',
      loadError: 'Practice could not be loaded', loadErrorDetail: 'Check your connection and retry. Your submitted work is saved.',
      uncertainError: 'This operation is not confirmed yet', uncertainDetail: 'Your code is preserved. Retrying will confirm this same operation without recording another submission.',
      restoredPending: 'Your last operation was not confirmed. You can retry it now.',
      operationError: 'The operation could not be completed', retryOperation: 'Retry this operation', refresh: 'Refresh status',
      network: 'The connection is unavailable. Please try again shortly.', badResponse: 'The service returned an unreadable response. Please try again.',
      timedOut: 'Waiting for the result timed out. Your code is preserved; retry this operation.',
      completeShort: 'Checks complete', pendingShort: 'Awaiting confirmation', notRun: 'Code could not be run.',
      welcomeDefault: 'Check your understanding with a small task. Inspect real results and work through any difficulties.',
    },
  };
  const tr = (key, values = {}) => String(words[lang()][key] || words.zh[key] || key)
    .replace(/\{(\w+)\}/g, (_, name) => values[name] == null ? '' : String(values[name]));
  const text = (id, value) => { $(id).textContent = value == null ? '' : String(value); };
  const create = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  };
  const readable = value => {
    if (value === undefined) return '';
    if (value === null) return 'None';
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
  };
  const icons = {
    parity: '<path d="M7 3v13a4 4 0 0 0 4 4h6M7 8h7a3 3 0 0 0 3-3V3M4 6l3-3 3 3m4 11 3 3-3 3"/>',
    'loop-sum': '<path d="M19 8a8 8 0 0 0-14-2L3 9m0-6v6h6m-4 7a8 8 0 0 0 14 2l2-3m0 6v-6h-6"/>',
    'function-return': '<path d="M9 4H7a2 2 0 0 0-2 2v3c0 2-2 3-2 3s2 1 2 3v3a2 2 0 0 0 2 2h2m6-16h2a2 2 0 0 1 2 2v3c0 2 2 3 2 3s-2 1-2 3v3a2 2 0 0 1-2 2h-2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    evidence: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zm0 0v6h6M8 15l2 2 5-5"/>',
  };
  const icon = name => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('class', 'icon');
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = icons[name] || icons.check;
    return node;
  };
  const familyLabels = {
    parity: { zh: ['分支', '奇偶与条件'], en: ['Branches', 'Parity & conditions'] },
    'loop-sum': { zh: ['循环', '边界与求和'], en: ['Loops', 'Bounds & sums'] },
    'function-return': { zh: ['函数', '返回与变化'], en: ['Functions', 'Returns & inputs'] },
  };
  const fallbackFamilies = () => [
    { id: 'parity', title: lang() === 'en' ? 'Branches and parity' : '分支与奇偶判断' },
    { id: 'loop-sum', title: lang() === 'en' ? 'Loop bounds and sums' : '循环边界与求和' },
    { id: 'function-return', title: lang() === 'en' ? 'Function returns and changing inputs' : '函数返回与输入变化' },
  ];
  const families = () => state.overview?.families?.length ? state.overview.families : fallbackFamilies();
  const currentTask = () => state.overview?.currentTask || null;
  const selectedTask = () => currentTask()?.familyId === state.selectedFamily ? currentTask() : null;
  const taskId = task => task?.taskId || task?.id;
  const isTransfer = task => (task?.purpose || task?.phase) === 'transfer';
  const isIndependent = task => task?.status === 'independent';
  const resultOf = task => task?.lastResult || task?.result || null;
  const isPassed = task => ['passed', 'independent'].includes(task?.status) ||
    (Number(resultOf(task)?.total) > 0 && Number(resultOf(task)?.passed) === Number(resultOf(task)?.total));
  const hintsUsed = task => Number(task?.assistance?.hintsUsed ?? task?.hintsUsed ?? 0);

  function localCopy() {
    document.querySelectorAll('[data-lab-text]').forEach(node => { node.textContent = tr(node.dataset.labText); });
    document.title = 'EduPilot · ' + tr('title');
    $('labTopics').setAttribute('aria-label', tr('topicsLabel'));
    $('labProgress').setAttribute('aria-label', tr('progressLabel'));
    $('labCode').placeholder = tr('placeholder');
    const back = new URL('/', location.origin);
    back.searchParams.set('course', courseId);
    back.searchParams.set('lang', lang());
    $('labBackLink').href = back.href;
    $('labPythonLink').href = '/learning-lab.html?course=python-intro&lang=' + lang();
    window.applySettings?.();
  }

  function renderTopics() {
    const fragment = document.createDocumentFragment();
    for (const family of families()) {
      const labels = familyLabels[family.id]?.[lang()] || [family.title || family.id, ''];
      const button = create('button', 'lab-topic');
      button.type = 'button';
      button.dataset.familyId = family.id;
      button.setAttribute('aria-pressed', String(state.selectedFamily === family.id));
      button.disabled = state.busy || Boolean(state.pending) || state.loading;
      const symbol = create('span', 'lab-topic-icon');
      symbol.appendChild(icon(family.id));
      const copy = create('span', 'lab-topic-copy');
      copy.append(create('span', 'lab-topic-name', labels[0]), create('span', 'lab-topic-detail', labels[1]));
      const check = icon('check');
      check.classList.add('lab-topic-check');
      button.append(symbol, copy, check);
      button.addEventListener('click', () => {
        if (state.busy || state.pending) return;
        saveDraft();
        state.selectedFamily = family.id;
        state.selectedExplicitly = true;
        state.revision++;
        clearError();
        render();
      });
      fragment.appendChild(button);
    }
    $('labTopics').replaceChildren(fragment);
  }

  function renderProgress(task) {
    const transfer = isTransfer(task);
    const touched = Number(task.attempts) > 0 || hintsUsed(task) > 0;
    const current = transfer ? 2 : touched ? 1 : 0;
    $('labProgress').querySelectorAll('li').forEach((node, index) => {
      node.dataset.state = index < current || isIndependent(task) ? 'done' : index === current ? 'active' : 'upcoming';
      if (index === current && !isIndependent(task)) node.setAttribute('aria-current', 'step');
      else node.removeAttribute('aria-current');
    });
  }

  function draftFor(task) {
    if (isPassed(task) && typeof task.currentCode === 'string') return task.currentCode;
    try {
      const stored = JSON.parse(localStorage.getItem(draftPrefix + taskId(task)) || 'null');
      if (stored && typeof stored.code === 'string') return stored.code;
    } catch (_) {}
    return typeof task.currentCode === 'string' && task.currentCode.length
      ? task.currentCode : (task.starterCode || task.problem?.starterCode || '');
  }

  function saveDraft() {
    if (!state.renderedTaskId) return;
    try {
      localStorage.setItem(draftPrefix + state.renderedTaskId, JSON.stringify({
        code: $('labCode').value, at: Date.now(),
      }));
      text('labSaveNote', tr('draftSaved'));
    } catch (_) { text('labSaveNote', tr('draftUnavailable')); }
  }

  function lineNumbers() {
    const lines = Math.max(8, $('labCode').value.split('\n').length);
    $('labLineNumbers').textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    $('labLineNumbers').scrollTop = $('labCode').scrollTop;
  }

  function renderTask(task) {
    const problem = task.problem || task;
    renderProgress(task);
    text('labPhase', tr(isTransfer(task) ? 'transfer' : 'practice'));
    $('labPhase').dataset.phase = isTransfer(task) ? 'transfer' : 'practice';
    text('labAssistance', tr(hintsUsed(task) > 0 ? 'assisted' : 'noHint'));
    text('labProblemTitle', task.title || problem.title || '');
    text('labLanguageNotice', task.languageNotice || '');
    $('labLanguageNotice').hidden = !task.languageNotice;
    text('labPrompt', task.prompt || problem.description || '');
    const constraints = Array.isArray(task.constraints) ? task.constraints : problem.constraints || [];
    $('labConstraints').replaceChildren(...constraints.map(item => create('li', '', readable(item))));
    $('labConstraints').hidden = !constraints.length;
    const examples = task.publicExamples || problem.publicExamples || [];
    $('labExamples').replaceChildren(...examples.map(example => {
      const row = create('div', 'lab-example');
      row.append(create('code', '', readable(example.input)), create('span', '', '→'), create('code', 'lab-example-output', readable(example.output)));
      return row;
    }));
    document.querySelector('.lab-examples').hidden = !examples.length;
    text('labTaskNote', tr(isTransfer(task)
      ? hintsUsed(task) > 0 ? 'assistedNote' : Number(task.attempts) > 0 && !isIndependent(task) ? 'retryTransferNote' : 'transferNote'
      : 'practiceNote'));
    const completedCodeChanged = isPassed(task) && typeof task.currentCode === 'string' && $('labCode').value !== task.currentCode;
    if (state.renderedTaskId !== taskId(task) || completedCodeChanged) {
      state.renderedTaskId = taskId(task);
      $('labCode').value = draftFor(task);
      $('labCode').scrollTop = 0;
      lineNumbers();
      if (isPassed(task)) saveDraft();
    }
    renderFeedback(task);
    renderHints(task);
    renderNext(task);
    updateControls();
  }

  function renderFeedback(task) {
    const result = resultOf(task);
    $('labFeedback').hidden = !result;
    if (!result) return;
    const passed = isPassed(task);
    const error = Boolean(result.error);
    $('labFeedback').dataset.pass = String(passed);
    text('labResultIcon', passed ? '✓' : error ? '·' : '↳');
    text('labFeedbackTitle', tr(isIndependent(task) ? 'independentTitle' : error ? 'errorTitle' : passed ? 'passedTitle' : 'reviseTitle'));
    text('labFeedbackSubtitle', tr(isIndependent(task) ? 'independentSubtitle' : error ? 'errorSubtitle' : passed ? 'passedSubtitle' : 'reviseSubtitle'));
    text('labResultCount', !error && Number(result.total) > 0 ? tr('count', { passed: result.passed || 0, total: result.total }) : '');
    const diagnosis = result.diagnosis;
    const summary = typeof diagnosis === 'string' ? diagnosis : diagnosis?.summary || diagnosis?.message || '';
    text('labDiagnosis', error ? readable(result.error) : summary);
    $('labDiagnosis').hidden = !(error || summary);
    const checks = Array.isArray(result.results) ? result.results : [];
    let evidence = result.failureEvidence;
    if (evidence && !Array.isArray(evidence)) evidence = [evidence];
    if (!evidence?.length) evidence = checks.filter(item =>
      (item.pass === false || item.passed === false) && (item.evidence ||
      ['input', 'expected', 'actual', 'error'].some(key => item[key] !== undefined)))
      .map(item => ({ ...item, ...(item.evidence || {}), checkId: item.id }));
    $('labFailureEvidence').replaceChildren(...(evidence || []).slice(0, 2).map(item => {
      const check = checks.find(check => check.id === (item.checkId || item.id));
      return counterexample({ desc: check?.desc, output: check?.output, ...item }, task);
    }));
    $('labChecks').replaceChildren(...checks.map((item, index) => {
      const row = create('li');
      const pass = item.pass === true || item.passed === true;
      const mark = create('span', 'lab-check-mark', pass ? '✓' : '·');
      mark.dataset.pass = String(pass);
      row.append(mark, create('span', '', item.desc || item.description || item.label || tr('check', { n: index + 1 })));
      return row;
    }));
    $('labCheckDetails').hidden = !checks.length;
  }

  function counterexample(item, task) {
    const card = create('div', 'lab-counterexample');
    card.appendChild(create('p', 'lab-counterexample-title', item.desc || item.description || item.label || tr('counterexample')));
    if (item.kind === 'constraint') {
      card.appendChild(create('p', 'lab-counterexample-note', tr('constraintFail')));
      return card;
    }
    const fields = create('div', 'lab-counterexample-grid');
    for (const [key, label] of [['input', 'input'], ['expected', 'expected'], ['actual', 'actual'], ['stdout', 'printed']]) {
      const value = item[key] !== undefined ? item[key] : key === 'input' ? item.call : undefined;
      if (value === undefined) continue;
      if (key === 'stdout' && !value) continue;
      let shown = readable(value);
      if (key === 'input' && Array.isArray(value)) {
        const signature = /def\s+([A-Za-z_]\w*)\s*\(/.exec(task.starterCode || task.problem?.starterCode || '');
        const args = value.map(arg => typeof arg === 'string' ? JSON.stringify(arg) : readable(arg)).join(', ');
        shown = signature ? signature[1] + '(' + args + ')' : args;
      }
      const cell = create('div', 'lab-counterexample-field');
      cell.append(create('span', '', tr(label)), create('pre', '', shown));
      fields.appendChild(cell);
    }
    if (fields.childElementCount) card.appendChild(fields);
    const exception = item.exception && [item.exception.type, item.exception.message].filter(Boolean).join(': ');
    const error = exception || item.error || item.message || item.stderr ||
      (typeof item.output === 'string' && /^[A-Za-z]+Error:/.test(item.output) ? item.output : '');
    if (error) card.appendChild(create('pre', 'lab-counterexample-error', readable(error)));
    return card;
  }

  function renderHints(task) {
    const hints = Array.isArray(task.visibleHints) ? task.visibleHints : [];
    $('labHints').hidden = !hints.length;
    text('labHintCount', tr('hintsCount', { n: hints.length }));
    text('labHintNote', tr('hintNote'));
    $('labHintList').replaceChildren(...hints.map((hint, index) => {
      const row = create('li');
      row.append(create('span', 'lab-hint-level', String(hint.level || index + 1)),
        create('p', '', typeof hint === 'string' ? hint : hint.text || hint.hint || ''));
      return row;
    }));
  }

  function renderNext(task) {
    const show = isPassed(task) && (isIndependent(task) || task.canNext !== false);
    $('labNextCard').hidden = !show;
    if (!show) return;
    const prefix = isIndependent(task) ? 'finished' : isTransfer(task) ? 'corrected' : 'next';
    text('labNextTitle', tr(prefix + 'Title'));
    text('labNextText', tr(prefix + 'Text'));
    text('labNextLabel', tr(prefix + 'Label'));
  }

  function renderEvidence() {
    const evidence = (state.overview?.evidence || []).filter(item =>
      item.verified === true && item.kind === 'independent_transfer');
    $('labRecords').hidden = !evidence.length;
    text('labRecordCount', tr('evidenceCount', { n: Number(state.overview?.summary?.independent) || evidence.length }));
    $('labEvidenceCards').replaceChildren(...evidence.slice(0, 3).map(item => {
      const card = create('article', 'lab-evidence-card');
      const heading = create('div', 'lab-evidence-heading');
      heading.append(icon('evidence'), create('span', '', tr('evidenceBadge')));
      const match = families().find(family => family.id === item.familyId);
      const title = match?.title || familyLabels[item.familyId]?.[lang()]?.[0] || tr('transfer');
      const facts = create('div', 'lab-evidence-facts');
      facts.append(create('span', '', tr('firstAttempt')), create('span', '', tr('withoutHints')));
      if (Number(item.passed) > 0) facts.appendChild(create('span', '', tr('checksPassed', { passed: item.passed })));
      let dateText = '';
      const date = new Date(item.at);
      if (!Number.isNaN(date.getTime())) dateText = new Intl.DateTimeFormat(lang() === 'en' ? 'en-US' : 'zh-CN', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }).format(date);
      card.append(heading, create('h3', '', title), facts, create('p', 'lab-evidence-date', dateText));
      return card;
    }));
  }

  function updateControls() {
    const task = selectedTask();
    const locked = state.busy || state.loading || Boolean(state.pending) || !state.overview;
    $('labStart').disabled = locked;
    $('labReset').disabled = locked || !task;
    $('labSubmit').disabled = locked || !task || isPassed(task) || !$('labCode').value.trim();
    $('labHint').disabled = locked || !task || task.canRequestHint === false || isPassed(task);
    $('labNext').disabled = locked || !task;
    $('labCode').readOnly = locked || !task || isPassed(task);
    const label = $('labHint').querySelector('span');
    label.textContent = tr(task?.canRequestHint === false && hintsUsed(task) >= 3 ? 'noMoreHints' : hintsUsed(task) > 0 ? 'nextHint' : 'hint');
    $('labTopics').querySelectorAll('button').forEach(button => { button.disabled = locked; });
    $('labContent').setAttribute('aria-busy', String(state.busy || state.loading));
    if (!state.busy) {
      text('labSubmitStatus', state.pending ? tr('pendingShort') : task?.attempts ? tr('attempt', { n: task.attempts }) : '');
    }
  }

  function render() {
    localCopy();
    const supported = courseId === 'python-intro' && state.overview?.supported !== false;
    $('labUnsupported').hidden = supported;
    $('labContent').hidden = !supported;
    if (!supported) return;
    renderTopics();
    $('labLoading').hidden = !state.loading;
    const task = selectedTask();
    $('labWelcome').hidden = state.loading || Boolean(task);
    $('labWorkspace').hidden = state.loading || !task;
    if (task) renderTask(task);
    else {
      const family = families().find(item => item.id === state.selectedFamily) || families()[0];
      text('labWelcomeTitle', family?.title || tr('title'));
      text('labWelcomeDescription', family?.description || tr('welcomeDefault'));
    }
    renderEvidence();
    updateControls();
  }

  function showError(title, message, retry, buttonKey = 'retry') {
    text('labErrorTitle', title);
    text('labErrorText', message);
    $('labError').hidden = false;
    state.retry = retry || null;
    $('labRetry').hidden = !retry;
    $('labRetry').disabled = false;
    text('labRetry', tr(buttonKey));
    text('labAnnouncement', title + '. ' + message);
  }
  function clearError() {
    $('labError').hidden = true;
    state.retry = null;
  }
  function storePending(operation) {
    state.pending = operation;
    try {
      if (operation) sessionStorage.setItem(pendingKey, JSON.stringify(operation));
      else sessionStorage.removeItem(pendingKey);
    } catch (_) {}
  }
  function restorePending() {
    try {
      const value = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
      if (value && ['start', 'reset', 'submit', 'hint', 'next'].includes(value.action)
        && value.body?.sessionId === sessionId && typeof value.body.requestId === 'string') return value;
    } catch (_) {}
    return null;
  }

  async function request(path, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await (window.eduFetch || fetch)(path, { ...options, signal: controller.signal });
      let data;
      try { data = await response.json(); }
      catch (_) { const error = new Error(tr('badResponse')); error.retryable = true; throw error; }
      if (!response.ok || data.ok === false || (data.error && !data.currentTask)) {
        const detail = typeof data.error === 'string' ? data.error : data.error?.message || data.message;
        const error = new Error(detail || tr('operationError'));
        error.retryable = response.status >= 500 || response.status === 408 || response.status === 429;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeoutError = new Error(tr('timedOut'));
        timeoutError.retryable = true;
        throw timeoutError;
      }
      if (error.retryable === undefined) error.retryable = true;
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function receive(data, selectCurrent) {
    state.overview = data;
    if (data.currentTask && (selectCurrent || !state.selectedExplicitly)) {
      state.selectedFamily = data.currentTask.familyId;
    }
    if (!families().some(item => item.id === state.selectedFamily)) state.selectedFamily = families()[0]?.id || 'parity';
  }

  async function loadOverview() {
    if (courseId !== 'python-intro') {
      state.loading = false;
      render();
      return;
    }
    if (state.busy) { state.refreshAfterRequest = true; return; }
    const revision = ++state.revision;
    const requestLanguage = lang();
    if (!state.overview) state.loading = true;
    render();
    try {
      const data = await request('/api/learning-lab?sessionId=' + encodeURIComponent(sessionId) + '&lang=' + requestLanguage);
      if (revision !== state.revision || requestLanguage !== lang()) return;
      receive(data, false);
      state.loading = false;
      if (!state.pending) clearError();
      render();
      if (state.pending) showError(tr('uncertainError'), tr('restoredPending'), () => perform(state.pending), 'retryOperation');
    } catch (error) {
      if (revision !== state.revision) return;
      state.loading = false;
      render();
      showError(tr('loadError'), error.message || tr('loadErrorDetail'), loadOverview);
    }
  }

  async function act(action) {
    if (state.busy || state.pending || state.loading || !state.overview) return;
    const task = selectedTask();
    if (!['start', 'reset'].includes(action) && !task) return;
    saveDraft();
    const body = { sessionId, requestId: crypto.randomUUID() };
    if (action === 'start' || action === 'reset') body.familyId = state.selectedFamily;
    else body.taskId = taskId(task);
    if (action === 'submit') {
      body.code = $('labCode').value;
      if (!body.code.trim()) {
        showError(tr('operationError'), tr('noCode'), null);
        $('labCode').focus();
        return;
      }
    }
    await perform({ action, body });
  }

  async function perform(operation) {
    if (!operation || state.busy) return;
    const revision = ++state.revision;
    const requestLanguage = lang();
    state.busy = true;
    storePending(operation);
    clearError();
    updateControls();
    text('labSubmitStatus', tr(operation.action === 'submit' ? 'working' : operation.action === 'hint' ? 'gettingHint' : 'opening'));
    try {
      const data = await request('/api/learning-lab/' + operation.action + '?lang=' + requestLanguage, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation.body),
      });
      storePending(null);
      if (revision === state.revision && requestLanguage === lang()) {
        receive(data, true);
        state.loading = false;
        render();
        text('labAnnouncement', operation.action === 'submit' ? tr(isIndependent(currentTask()) ? 'independentTitle' : 'completeShort') : tr('checked'));
      } else state.refreshAfterRequest = true;
    } catch (error) {
      if (!error.retryable) storePending(null);
      if (revision === state.revision) {
        showError(tr(error.retryable ? 'uncertainError' : 'operationError'),
          error.retryable ? (error.name === 'TypeError' ? tr('network') : error.message || tr('uncertainDetail')) + ' ' + tr('uncertainDetail') : error.message,
          error.retryable ? () => perform(operation) : loadOverview,
          error.retryable ? 'retryOperation' : 'refresh');
      }
    } finally {
      state.busy = false;
      updateControls();
      if (state.refreshAfterRequest) {
        state.refreshAfterRequest = false;
        await loadOverview();
      }
    }
  }

  $('labStart').addEventListener('click', () => act('start'));
  $('labReset').addEventListener('click', () => act('reset'));
  $('labSubmit').addEventListener('click', () => act('submit'));
  $('labHint').addEventListener('click', () => act('hint'));
  $('labNext').addEventListener('click', () => act(isIndependent(selectedTask()) ? 'reset' : 'next'));
  $('labRetry').addEventListener('click', () => { if (!state.busy && state.retry) state.retry(); });
  $('labCode').addEventListener('input', () => { saveDraft(); lineNumbers(); updateControls(); });
  $('labCode').addEventListener('scroll', () => { $('labLineNumbers').scrollTop = $('labCode').scrollTop; });
  $('labCode').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!$('labSubmit').disabled) act('submit');
      return;
    }
    if (event.key !== 'Tab' || event.shiftKey || $('labCode').readOnly) return;
    event.preventDefault();
    const field = $('labCode');
    const start = field.selectionStart;
    field.setRangeText('    ', start, field.selectionEnd, 'end');
    saveDraft();
    lineNumbers();
    updateControls();
  });
  window.addEventListener('pagehide', saveDraft);
  window.addEventListener('edu-language-change', () => {
    saveDraft();
    render();
    if (state.busy) state.refreshAfterRequest = true;
    else loadOverview();
  });
  window.addEventListener('edu:activate', event => {
    state.active = event.detail?.active !== false;
    if (!state.active) { saveDraft(); return; }
    window.applySettings?.();
    if (event.detail?.refresh || event.detail?.visibilityChanged) loadOverview();
  });
  window.addEventListener('storage', event => {
    if (event.key === 'eduowl_lang' && ['zh', 'en'].includes(event.newValue) && event.newValue !== lang()) {
      window.setEduLanguage?.(event.newValue);
    }
  });

  state.pending = restorePending();
  render();
  loadOverview();
})();
