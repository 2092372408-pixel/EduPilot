/* Public run summaries only. Never render model inputs, secrets or hidden reasoning. */
(() => {
  'use strict';
  const instances = new Set();
  const byContainer = new WeakMap();
  const language = () => window.eduLanguage?.() === 'en' ? 'en' : 'zh';
  const t = (zh, en) => language() === 'en' ? en : zh;
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const labels = {
    running: ['执行中', 'Running'], completed: ['已完成', 'Completed'], blocked: ['已停止', 'Stopped'],
    failed: ['未完成', 'Failed'], cancelled: ['已取消', 'Cancelled'], interrupted: ['已中断', 'Interrupted'],
    waiting_for_student: ['等待你作答，本轮已结束', 'Waiting for your answer; this run has ended'],
    budget_exhausted: ['本轮额度已用完', 'Run budget exhausted'], deadline_exceeded: ['已达到本轮时限', 'Run time limit reached'],
    deadline: ['已达到本轮时限', 'Run time limit reached'], cancelled_by_user: ['已按请求取消', 'Cancelled on request'],
    task_changed: ['题目已变化', 'The task changed'], scope_deleted: ['课程已删除', 'Course deleted'],
    completed_normally: ['本轮处理完成', 'Run completed'], error: ['执行遇到问题', 'Execution encountered a problem'],
    run_started: ['开始处理', 'Run started'], run_completed: ['本轮完成', 'Run completed'],
    run_stopped: ['停止执行', 'Run stopped'], run_cancelled: ['取消执行', 'Run cancelled'],
    run_interrupted: ['运行中断', 'Run interrupted'], run_resumed: ['从已确认步骤继续', 'Continued from confirmed progress'],
    model_reserved: ['预留模型调用额度', 'Model call budget reserved'], model_started: ['调用模型', 'Model called'],
    model_completed: ['模型调用完成', 'Model call completed'], model_failed: ['模型调用未完成', 'Model call failed'],
    model_usage: ['结算模型用量', 'Model usage settled'], tool_started: ['执行工具', 'Tool started'],
    model_finished: ['模型调用已结算', 'Model call accounted for'], tool_finished: ['工具执行完成', 'Tool completed'],
    tool_reserved: ['预留工具调用额度', 'Tool call budget reserved'], budget_stopped: ['额度不足，停止新调用', 'Budget exhausted; further calls stopped'],
    business_committed: ['学习结果已保存', 'Learning result saved'], action_rejected: ['动作未通过校验', 'Action rejected by validation'],
    tool_replayed: ['复用已确认的工具结果', 'Reused a confirmed tool result'],
    maintenance_started: ['维护学习记忆', 'Updating learning memory'], maintenance_completed: ['学习记忆已更新', 'Learning memory updated'],
    maintenance_skipped: ['本轮记忆维护已停止', 'Memory maintenance stopped for this run'],
    tool_completed: ['工具执行完成', 'Tool completed'], tool_failed: ['工具执行未完成', 'Tool failed'],
    action_committed: ['学习结果已保存', 'Learning result saved'], checkpoint: ['确认步骤已保存', 'Progress confirmed'],
    policy_blocked: ['动作未通过校验', 'Action rejected by validation'], assistance_recorded: ['帮助记录已保存', 'Help recorded'],
  };
  const label = (code, fallback) => labels[code]?.[language() === 'en' ? 1 : 0] || fallback;
  const number = value => value !== undefined && value !== null && Number.isFinite(Number(value)) ? String(Number(value)) : '—';
  const time = value => {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleTimeString(language() === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  };
  async function request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options?.method ? 180000 : 15000);
    try {
      const response = await (window.eduFetch || fetch)(url, { ...options, signal: controller.signal });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || t('无法读取运行记录', 'Run activity is unavailable'));
      return data;
    } finally { clearTimeout(timer); }
  }
  function mount(container, options = {}) {
    if (typeof container === 'string') container = document.querySelector(container);
    if (!container) return null;
    if (byContainer.has(container)) return byContainer.get(container);
    const getSessionId = options.getSessionId || (() => options.sessionId);
    let session = '', version = 0, selectedId = null, runs = [], detail = null, pending = false;
    const root = make('details', 'run-activity');
    const summary = make('summary');
    const title = make('span'); const count = make('span', 'run-activity-count'); summary.append(title, count);
    const content = make('div', 'run-activity-content');
    const toolbar = make('div', 'run-activity-toolbar');
    const status = make('p', 'run-activity-status'); status.setAttribute('aria-live', 'polite');
    const reload = make('button', 'btn-ghost small'); reload.type = 'button';
    toolbar.append(status, reload);
    const list = make('ul', 'run-activity-list');
    const panel = make('section', 'run-activity-detail');
    content.append(toolbar, list, panel); root.append(summary, content); container.append(root);
    function showStatus(message, error = false) {
      status.textContent = message; status.classList.toggle('run-activity-error', error);
    }
    function render() {
      title.textContent = t('活动记录', 'Run activity');
      count.textContent = runs.length ? String(runs.length) : '';
      reload.textContent = t('刷新', 'Refresh'); reload.disabled = pending;
      list.replaceChildren(); panel.replaceChildren();
      for (const run of runs.slice(0, 10)) {
        const item = make('li'); const select = make('button'); select.type = 'button';
        select.setAttribute('aria-pressed', String(selectedId === run.runId));
        select.disabled = pending;
        select.append(make('span', '', label(run.status, t('状态待确认', 'Status unconfirmed'))), make('small', '', time(run.createdAt)));
        select.addEventListener('click', () => choose(run.runId)); item.append(select); list.append(item);
      }
      if (!detail) return;
      const heading = make('div', 'run-activity-detail-head');
      heading.append(make('strong', '', label(detail.status, t('状态待确认', 'Status unconfirmed'))));
      const id = make('code', 'run-activity-id', String(detail.runId || '').slice(0, 12));
      id.title = String(detail.runId || ''); heading.append(id); panel.append(heading);
      panel.append(make('p', 'run-activity-stop', label(detail.stopReason,
        detail.status === 'running' ? t('正在处理当前请求', 'Processing this request') : t('本轮执行已结束', 'This run has ended'))));
      const budget = detail.budget || {};
      const stats = make('dl', 'run-activity-stats');
      for (const [name, value] of [
        [t('模型调用', 'Model calls'), `${number(budget.modelCalls)} / ${number(budget.maxModelCalls)}`],
        [t('工具调用', 'Tool calls'), `${number(budget.toolCalls)} / ${number(budget.maxToolCalls)}`],
        [t('已结算 Token', 'Settled tokens'), number(budget.tokensUsed)],
        [t('预留 Token', 'Reserved tokens'), number(budget.tokensReserved)],
      ]) { const pair = make('div'); pair.append(make('dt', '', name), make('dd', '', value)); stats.append(pair); }
      panel.append(stats);
      if (Number(budget.unknownCalls) > 0) panel.append(make('p', 'run-activity-note', t(
        `${number(budget.unknownCalls)} 次调用的用量尚未确认，预留额度仍保留。`,
        `Usage for ${number(budget.unknownCalls)} calls is unconfirmed; their reservation remains.`)));
      if (detail.resumeOf) panel.append(make('p', 'run-activity-note', t('本次继续沿用原运行的预算。', 'This continuation shares the original run budget.')));
      const actions = make('div', 'run-activity-actions');
      for (const [action, text] of [
        ...(detail.status === 'running' ? [['cancel', t('取消本轮', 'Cancel run')]] : []),
        ...(detail.canResume === true ? [['resume', t('继续执行', 'Resume run')]] : []),
      ]) {
        const control = make('button', 'btn-ghost small', text); control.type = 'button'; control.disabled = pending;
        control.addEventListener('click', () => mutate(action, detail.runId)); actions.append(control);
      }
      if (actions.childElementCount) panel.append(actions);
      const events = make('ol', 'run-activity-events');
      for (const event of (detail.events || []).slice(-30)) {
        const item = make('li');
        item.append(make('time', '', time(event.at)), make('span', '', label(event.type, t('运行状态已更新', 'Run state updated'))));
        // tool is a machine identifier, never arbitrary model output or arguments.
        if (/^[a-zA-Z0-9_.:-]{1,80}$/.test(event.tool || '')) item.append(make('code', '', event.tool));
        events.append(item);
      }
      if (events.childElementCount) panel.append(events);
    }
    async function choose(id) {
      const ownVersion = ++version; const ownSession = String(getSessionId() || '');
      selectedId = id; detail = null; render(); showStatus(t('正在读取详情…', 'Loading details…'));
      try {
        const value = await request('/api/runs/' + encodeURIComponent(id) + '?sessionId=' + encodeURIComponent(ownSession));
        if (ownVersion !== version || ownSession !== String(getSessionId() || '')) return;
        detail = value.run || value; render(); showStatus('');
      } catch (_) { if (ownVersion === version) showStatus(t('运行详情暂时不可用，请刷新。', 'Run details are unavailable. Refresh to try again.'), true); }
    }
    async function refresh() {
      if (pending || !container.isConnected) return;
      const ownSession = String(getSessionId() || '');
      if (!ownSession) return;
      const ownVersion = ++version;
      if (session !== ownSession) { session = ownSession; runs = []; detail = null; selectedId = null; }
      render();
      try {
        const value = await request('/api/runs?sessionId=' + encodeURIComponent(ownSession));
        if (ownVersion !== version || ownSession !== String(getSessionId() || '')) return;
        runs = Array.isArray(value.runs) ? value.runs : []; render();
        showStatus(runs.length ? t('选择一次运行查看已确认的活动。', 'Select a run to inspect confirmed activity.') : t('本课程还没有运行记录。', 'No run activity for this course yet.'));
        if (root.open && runs.length) await choose(runs.some(run => run.runId === selectedId) ? selectedId : runs[0].runId);
      } catch (_) { if (ownVersion === version) showStatus(t('暂时无法读取活动记录，请刷新。', 'Activity is unavailable. Refresh to try again.'), true); }
    }
    async function mutate(action, runId) {
      if (pending) return;
      const ownSession = String(getSessionId() || '');
      pending = true; render(); showStatus(t('正在处理…', 'Working…'));
      try {
        await request('/api/runs/' + encodeURIComponent(runId) + '/' + action, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: ownSession }),
        });
        if (ownSession === String(getSessionId() || '')) window.dispatchEvent(new CustomEvent('edu-run-updated', { detail: { sessionId: ownSession, action, runId, kind: detail?.kind } }));
      } catch (_) { showStatus(t('操作结果尚未确认，请刷新记录。', 'The operation is not confirmed. Refresh the activity.'), true); }
      finally { pending = false; await refresh(); }
    }
    reload.addEventListener('click', refresh);
    root.addEventListener('toggle', () => { if (root.open) refresh(); });
    const instance = { refresh, element: root };
    instances.add(instance); byContainer.set(container, instance); render(); refresh();
    return instance;
  }
  function refresh() { return Promise.allSettled([...instances].map(instance => instance.refresh())); }
  window.addEventListener('edu-language-change', refresh);
  window.EduRunActivity = { mount, refresh };
})();
