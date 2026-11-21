'use strict';
// Application checkpoints share the learning database. External work never runs
// inside commitBusiness's short SQLite transaction.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, randomUUID } = require('node:crypto');
const sessionStore = require('../store/sessionStore');
const { callCore } = require('./python-core');
const context = new AsyncLocalStorage();
const maintenance = new AsyncLocalStorage();
const active = new Map();
let initialized = false;
const VERSION = 'learning-harness-2';
const scopeOf = value => String(value || 'default').split('~')[0];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function stable(value) { return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value; }
function error(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
function safeText(value, length = 160) { return String(value || '').replace(/(?:Bearer\s+|sk-)[\w.-]+/gi, '[redacted]').slice(0, length); }
function summary(value = {}) {
  const out = {};
  for (const key of ['tool', 'actor', 'action', 'kind', 'status', 'stopReason', 'code', 'reason', 'step', 'passed', 'total', 'verified', 'runId', 'resumeOf', 'label', 'calls', 'knownUsage', 'tokens', 'replayed']) {
    const item = value[key];
    if (typeof item === 'string') out[key] = safeText(item);
    else if (typeof item === 'boolean' || Number.isFinite(item)) out[key] = item;
  }
  return out;
}
function db() {
  const database = sessionStore.getDb();
  if (!initialized) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS harness_scopes (scope_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS harness_budgets (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS harness_runs (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, session_id TEXT NOT NULL, course_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL, input_hash TEXT NOT NULL, kind TEXT NOT NULL, input_json TEXT NOT NULL, config_json TEXT NOT NULL,
        budget_group_id TEXT NOT NULL, resume_of TEXT, generation INTEGER NOT NULL, status TEXT NOT NULL, stop_reason TEXT,
        result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(scope_id,trigger_id));
      CREATE INDEX IF NOT EXISTS harness_runs_scope ON harness_runs(scope_id,created_at);
      CREATE INDEX IF NOT EXISTS harness_runs_course ON harness_runs(course_id);
      CREATE TABLE IF NOT EXISTS harness_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, summary_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS harness_events_run ON harness_events(run_id,id);
      CREATE TABLE IF NOT EXISTS harness_actions (run_id TEXT NOT NULL, action_key TEXT NOT NULL, tool TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, PRIMARY KEY(run_id,action_key));
      CREATE TABLE IF NOT EXISTS harness_calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, budget_group_id TEXT NOT NULL, reserved_tokens INTEGER NOT NULL, status TEXT NOT NULL, usage_json TEXT);
    `);
    const columns = new Set(database.prepare('PRAGMA table_info(harness_runs)').all().map(column => column.name));
    if (!columns.has('state_revision')) database.exec('ALTER TABLE harness_runs ADD COLUMN state_revision INTEGER');
    if (!columns.has('state_generation')) database.exec('ALTER TABLE harness_runs ADD COLUMN state_generation TEXT');
    database.prepare("UPDATE harness_runs SET status='interrupted',stop_reason='process_interrupted',updated_at=? WHERE status='running'").run(Date.now());
    initialized = true;
  }
  return database;
}
function generation(scope) {
  db().prepare('INSERT OR IGNORE INTO harness_scopes(scope_id,generation) VALUES(?,0)').run(scope);
  return db().prepare('SELECT generation FROM harness_scopes WHERE scope_id=?').get(scope).generation;
}
function current() { return context.getStore() || null; }
function currentSignal() { return current()?.signal; }
function configValue(name) { const ctx = current(); return ctx && Object.hasOwn(ctx.config, name) ? ctx.config[name] : process.env[name]; }
function assertCurrent() {
  const ctx = current();
  if (!ctx) return null;
  if (ctx.invalidated || generation(ctx.scopeId) !== ctx.generation) throw error('scope_deleted', 'This learning scope was reset or deleted.', 410);
  ctx.signal.throwIfAborted();
  if (ctx.closed) throw error('run_finished', 'This run is already finished. Background model work was stopped.');
  if (ctx.budgetBlocked) throw error(ctx.budgetBlocked, 'The execution budget is exhausted.', 429);
  if (maintenance.getStore()?.exhausted) throw error('budget_exhausted', 'The maintenance budget is exhausted.', 429);
  if (Date.now() >= ctx.deadline) throw error('deadline_exceeded', 'The run deadline has passed.', 429);
  return ctx;
}
function event(type, value = {}, runId = current()?.id) {
  if (!runId || !db().prepare('SELECT id FROM harness_runs WHERE id=?').get(runId)) return;
  db().prepare('INSERT INTO harness_events(run_id,type,summary_json,created_at) VALUES(?,?,?,?)').run(runId, safeText(type, 80), JSON.stringify(summary(value)), Date.now());
}
function budgetOf(id) { const row = db().prepare('SELECT data FROM harness_budgets WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
function publicRun(row, includeEvents = false) {
  if (!row) return null;
  const savedConfig = JSON.parse(row.config_json);
  const state = sessionStore.scopeVersion?.(row.scope_id);
  const stateMatches = !state || (row.state_revision === state.revision && row.state_generation === state.generation);
  const data = { runId: row.id, sessionId: row.session_id, courseId: row.course_id, kind: row.kind, status: row.status,
    stopReason: row.stop_reason, resumeOf: row.resume_of, budgetGroupId: row.budget_group_id,
    config: Object.fromEntries(['rulesVersion', 'LLM_MODEL', 'LLM_PROVIDER', 'ENGINE'].map(key => [key, safeText(savedConfig[key])])), budget: budgetOf(row.budget_group_id), createdAt: row.created_at, updatedAt: row.updated_at,
    canResume: stateMatches && ['interrupted', 'failed', 'cancelled'].includes(row.status) && Date.now() < (budgetOf(row.budget_group_id)?.deadline || 0) };
  if (includeEvents) data.events = db().prepare('SELECT id,type,summary_json,created_at FROM harness_events WHERE run_id=? ORDER BY id LIMIT 1000').all(row.id)
    .map(item => ({ sequence: item.id, type: item.type, ...JSON.parse(item.summary_json), at: item.created_at }));
  return data;
}
function ownedRun(runId, sessionId) {
  const row = db().prepare('SELECT * FROM harness_runs WHERE id=? AND scope_id=?').get(String(runId), scopeOf(sessionId));
  if (!row) throw error('run_not_found', 'Run not found in this learning scope.', 404);
  if (row.generation !== generation(row.scope_id)) throw error('scope_deleted', 'The learning scope has changed.', 410);
  return row;
}
function getRun(runId, sessionId, options = {}) { return publicRun(ownedRun(runId, sessionId), options.events !== false); }
function listRuns(sessionId, limit = 20) {
  return db().prepare('SELECT * FROM harness_runs WHERE scope_id=? ORDER BY created_at DESC LIMIT ?').all(scopeOf(sessionId), Math.min(100, Math.max(1, Number(limit) || 20))).map(row => publicRun(row));
}
function limits(input = {}) {
  const bounded = (name, fallback, maximum) => Math.max(name === 'timeoutMs' ? 1 : 0, Math.min(maximum, Number.isFinite(Number(input[name])) ? Number(input[name]) : fallback));
  return { maxModelCalls: bounded('maxModelCalls', 12, 40), maxToolCalls: bounded('maxToolCalls', 24, 80), maxRepairAttempts: bounded('maxRepairAttempts', 2, 4),
    maxEstimatedTokens: bounded('maxEstimatedTokens', 120000, 500000), modelCalls: 0, toolCalls: 0, repairs: 0, tokensUsed: 0, tokensReserved: 0, unknownCalls: 0,
    deadline: Date.now() + bounded('timeoutMs', 120000, 300000) };
}
function configSnapshot() {
  const base = process.env.LLM_BASE_URL || '';
  let safeBase = '';
  try { const url = new URL(base); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; safeBase = url.toString(); } catch (_) {}
  return { rulesVersion: VERSION, LLM_BASE_URL: safeBase, endpointFingerprint: hash(base),
    ...Object.fromEntries(['LLM_MODEL', 'LLM_PROVIDER', 'LLM_DISABLE_THINKING', 'LLM_MODE', 'EDUPILOT_TEST_MODE', 'ENGINE', 'EMBED_MODEL', 'EMBED_PROVIDER'].map(key => [key, process.env[key] || ''])) };
}
function finishReason(reason) { if (current()) current().stopReason = safeText(reason, 80); }
async function withRun(options, fn) {
  if (current() && !current().closed) {
    assertCurrent();
    if (options.sessionId && scopeOf(options.sessionId) !== current().scopeId) throw error('scope_mismatch', 'A nested run cannot change learning scope.', 403);
    return fn(current());
  }
  const database = db();
  const scopeId = scopeOf(options.sessionId), triggerId = String(options.triggerId || randomUUID());
  const input = clone(options.input || {}), inputHash = hash({ kind: options.kind || 'chat', input });
  let row = database.prepare('SELECT * FROM harness_runs WHERE scope_id=? AND trigger_id=?').get(scopeId, triggerId);
  if (row) {
    if (row.input_hash !== inputHash) throw error('request_conflict', 'The same request ID was used with different content.');
    if (row.status === 'completed' && row.result_json) return { ...JSON.parse(row.result_json), harness: { ...publicRun(row), replayed: true } };
    if (row.status === 'running') throw error('run_active', 'This request is already running.');
    throw error('run_requires_resume', 'This request stopped. Use its explicit resume action.');
  }
  let old = null;
  if (options.resumeOf) {
    old = ownedRun(options.resumeOf, options.sessionId);
    if (!['interrupted', 'failed', 'cancelled'].includes(old.status)) throw error('run_not_resumable', 'This run cannot be resumed.');
    if (old.input_hash !== inputHash || old.kind !== (options.kind || 'chat')) throw error('resume_conflict', 'Resume must use the original input and kind.');
    const state = sessionStore.scopeVersion?.(scopeId);
    if (state && (old.state_revision !== state.revision || old.state_generation !== state.generation)) throw error('resume_state_changed', 'Learning changed after this checkpoint. Start a new request.');
  }
  if ([...active.values()].some(value => value.scopeId === scopeId && !value.closed)) throw error('scope_busy', 'Another run is active in this learning scope.');
  const budgetId = old?.budget_group_id || randomUUID();
  const budget = old ? budgetOf(budgetId) : limits(options.limits);
  if (!budget || Date.now() >= budget.deadline) throw error('deadline_exceeded', 'The original deadline has passed; this run cannot receive a new budget.', 429);
  const config = old ? JSON.parse(old.config_json) : configSnapshot();
  if (old && config.endpointFingerprint !== hash(process.env.LLM_BASE_URL || '')) throw error('resume_config_changed', 'The model endpoint changed. Start a new request with the new configuration.');
  if (old && config.LLM_MODE === 'mock' && process.env.EDUPILOT_TEST_MODE !== '1') throw error('resume_config_changed', 'A scripted test run cannot resume in a product session.');
  const id = randomUUID(), now = Date.now(), gen = generation(scopeId);
  const state = sessionStore.scopeVersion?.(scopeId);
  database.transaction(() => {
    if (!old) database.prepare('INSERT INTO harness_budgets(id,scope_id,data) VALUES(?,?,?)').run(budgetId, scopeId, JSON.stringify(budget));
    database.prepare('INSERT INTO harness_runs(id,scope_id,session_id,course_id,trigger_id,input_hash,kind,input_json,config_json,budget_group_id,resume_of,generation,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, scopeId, String(options.sessionId || 'default'), String(options.courseId || 'python-intro'), triggerId, inputHash, options.kind || 'chat', JSON.stringify(input), JSON.stringify(config), budgetId, old?.id || null, gen, 'running', now, now);
    database.prepare('UPDATE harness_runs SET state_revision=?,state_generation=? WHERE id=?').run(state?.revision ?? null, state?.generation ?? null, id);
  })();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(error('deadline_exceeded', 'The run deadline has passed.', 429)), Math.max(1, budget.deadline - Date.now()));
  timeout.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const ctx = { id, scopeId, sessionId: String(options.sessionId || 'default'), courseId: String(options.courseId || 'python-intro'), generation: gen, budgetGroupId: budgetId,
    deadline: budget.deadline, config: { ...config, LLM_BASE_URL: process.env.LLM_BASE_URL || '', LLM_API_KEY: process.env.LLM_API_KEY || '', DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY || '', SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY || '' }, signal, controller, closed: false, invalidated: false,
    stopReason: null, queue: Promise.resolve(), step: 0 };
  active.set(id, ctx);
  event('run_started', { kind: options.kind || 'chat', resumeOf: old?.id }, id);
  return context.run(ctx, async () => {
    try {
      assertCurrent();
      const result = await fn(ctx);
      await ctx.queue;
      assertCurrent();
      const reason = ctx.stopReason || 'completed';
      database.transaction(() => {
        database.prepare("UPDATE harness_runs SET status='completed',stop_reason=?,result_json=?,updated_at=? WHERE id=?").run(reason, JSON.stringify(result ?? {}), Date.now(), id);
        event('run_stopped', { status: 'completed', stopReason: reason }, id);
      })();
      return { ...(result || {}), harness: publicRun(database.prepare('SELECT * FROM harness_runs WHERE id=?').get(id)) };
    } catch (err) {
      const cause = signal.aborted ? signal.reason : err;
      const code = typeof cause?.code === 'string' ? cause.code : (signal.aborted ? 'cancelled' : typeof err.code === 'string' ? err.code : 'execution_failed');
      const status = code === 'budget_exhausted' || code === 'deadline_exceeded' ? 'blocked' : signal.aborted ? 'cancelled' : 'failed';
      database.transaction(() => {
        database.prepare('UPDATE harness_runs SET status=?,stop_reason=?,updated_at=? WHERE id=?').run(status, code, Date.now(), id);
        event('run_stopped', { status, stopReason: code }, id);
      })();
      const reported = signal.aborted && typeof cause?.code !== 'string'
        ? error('cancelled', 'The run was cancelled.', 409) : cause instanceof Error ? cause : err;
      reported.runId = id;
      reported.harness = publicRun(database.prepare('SELECT * FROM harness_runs WHERE id=?').get(id));
      throw reported;
    } finally {
      ctx.closed = true;
      clearTimeout(timeout);
      // No detached model request may outlive its run. Already issued calls
      // retain their reservations and settle as unknown if cancellation wins.
      if (!controller.signal.aborted) controller.abort(error('run_finished', 'The run is complete.', 409));
      active.delete(id);
    }
  });
}
function reserve(kind, reserveTokens = 0, label = kind) {
  const ctx = assertCurrent();
  if (!ctx) return null;
  let ticket;
  try { db().transaction(() => {
    const decision = callCore('reserve_budget', { budget: budgetOf(ctx.budgetGroupId), kind, reserveTokens, now: Date.now() });
    if (!decision.ok) throw error(decision.code, decision.reason, 429);
    db().prepare('UPDATE harness_budgets SET data=? WHERE id=?').run(JSON.stringify(decision.budget), ctx.budgetGroupId);
    const id = randomUUID();
    if (kind === 'model') db().prepare('INSERT INTO harness_calls(id,run_id,budget_group_id,reserved_tokens,status) VALUES(?,?,?,?,?)').run(id, ctx.id, ctx.budgetGroupId, reserveTokens, 'reserved');
    event(kind + '_reserved', { label, calls: kind === 'model' ? decision.budget.modelCalls : decision.budget.toolCalls });
    ticket = { id, runId: ctx.id, budgetGroupId: ctx.budgetGroupId };
  })(); } catch (err) {
    if (err.code === 'budget_exhausted' || err.code === 'deadline_exceeded') {
      const child = maintenance.getStore();
      if (child && err.code === 'budget_exhausted') child.exhausted = true;
      else ctx.budgetBlocked = err.code;
      event('budget_stopped', { code: err.code, kind, label });
    }
    throw err;
  }
  return ticket;
}
function settle(ticket, usage, failed = false) {
  if (!ticket) return;
  db().transaction(() => {
    const row = db().prepare('SELECT * FROM harness_calls WHERE id=?').get(ticket.id);
    if (!row || row.status !== 'reserved') return;
    const budget = budgetOf(row.budget_group_id); if (!budget) return;
    const input = usage?.prompt_tokens ?? usage?.input_tokens;
    const output = usage?.completion_tokens ?? usage?.output_tokens ?? (usage?.total_tokens === input ? 0 : undefined);
    const known = !failed && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0;
    if (known) { budget.tokensReserved = Math.max(0, budget.tokensReserved - row.reserved_tokens); budget.tokensUsed += input + output; }
    else budget.unknownCalls += 1;
    db().prepare('UPDATE harness_budgets SET data=? WHERE id=?').run(JSON.stringify(budget), row.budget_group_id);
    db().prepare('UPDATE harness_calls SET status=?,usage_json=? WHERE id=?').run(known ? 'settled' : 'unknown', known ? JSON.stringify({ input, output }) : null, row.id);
    event('model_finished', { knownUsage: known, tokens: known ? input + output : row.reserved_tokens }, row.run_id);
  })();
}
async function meteredFetch(url, init = {}, label = 'model') {
  if (!current()) return fetch(url, init);
  assertCurrent();
  let body; try { body = JSON.parse(init.body || '{}'); } catch (_) { body = {}; }
  const maxOutput = label === 'embedding' ? 0 : Math.max(1, Number(body.max_completion_tokens || body.max_tokens || body.max_output_tokens || body.parameters?.max_tokens || 4096));
  if (!Number.isFinite(maxOutput) || maxOutput > 16000) throw error('budget_exhausted', 'The requested output exceeds the per-call limit.', 429);
  const text = typeof init.body === 'string' ? init.body : '';
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const reserveTokens = Math.ceil(cjk + (text.length - cjk) / 3) + maxOutput;
  const ticket = reserve('model', reserveTokens, label);
  let response;
  try { response = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, currentSignal()]) : currentSignal() }); }
  catch (err) { settle(ticket, null, true); throw err; }
  if (!response.body) { settle(ticket, null, true); return response; }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const sse = (response.headers.get('content-type') || '').includes('text/event-stream');
  let buffer = '', usage = null, done = false, protocolComplete = false;
  const accept = raw => {
    // The OpenAI SDK ends its iterator at [DONE] and cancels the underlying
    // reader instead of consuming the HTTP EOF. This is a successful response,
    // not an unknown-cost cancellation of an unfinished model call.
    if (raw.trim() === '[DONE]') { protocolComplete = true; return; }
    try { const value = JSON.parse(raw); if (value.usage) usage = value.usage; } catch (_) {}
  };
  const finish = failed => { if (!done) { done = true; settle(ticket, usage, failed); } };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
          if (sse) { if (buffer.startsWith('data:')) accept(buffer.slice(5).trim()); } else accept(buffer);
          finish(!response.ok); controller.close(); reader.releaseLock(); return;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        if (sse) { const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) if (line.startsWith('data:')) accept(line.slice(5).trim()); }
        if (buffer.length > 2000000) buffer = buffer.slice(-2000000);
        controller.enqueue(chunk.value);
      } catch (err) { finish(true); controller.error(err); }
    },
    async cancel(reason) { finish(!response.ok || !protocolComplete); await reader.cancel(reason); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
function commitBusiness(action, write) {
  const ctx = assertCurrent();
  if (write?.constructor?.name === 'AsyncFunction') throw error('async_transaction', 'A database commit callback must be synchronous.', 500);
  if (!ctx) return db().transaction(write)();
  const key = String(action.key || `commit-${++ctx.step}`), tool = String(action.tool || 'learning_commit');
  const inputHash = hash(action.input || {});
  const previous = db().prepare('SELECT * FROM harness_actions WHERE run_id=? AND action_key=?').get(ctx.id, key);
  if (previous) {
    if (previous.input_hash !== inputHash) throw error('action_conflict', 'An action ID was reused with different content.');
    if (previous.status === 'completed') return JSON.parse(previous.result_json || '{}');
  } else db().prepare('INSERT INTO harness_actions(run_id,action_key,tool,input_hash,status) VALUES(?,?,?,?,?)').run(ctx.id, key, tool, inputHash, 'pending');
  return db().transaction(() => {
    assertCurrent();
    const value = write();
    if (value && typeof value.then === 'function') throw error('async_transaction', 'A database commit callback must be synchronous.', 500);
    const result = action.result === undefined ? value ?? {} : action.result;
    db().prepare("UPDATE harness_actions SET status='completed',result_json=? WHERE run_id=? AND action_key=?").run(JSON.stringify(result), ctx.id, key);
    const version = sessionStore.scopeVersion?.(ctx.scopeId);
    db().prepare('UPDATE harness_runs SET updated_at=?,state_revision=?,state_generation=? WHERE id=?').run(Date.now(), version?.revision ?? null, version?.generation ?? null, ctx.id);
    event('business_committed', { tool, step: ctx.step });
    return value;
  })();
}
async function executeTool(name, input, session, fn, options = {}) {
  const ctx = current();
  if (!ctx) return fn(session);
  // This separate host-only argument is never read from model-supplied input.
  // Trusted core fallbacks may act for an explicit student request; graph and
  // legacy model tools retain the default agent policy.
  const actor = options.actor || 'agent';
  const work = async () => {
    assertCurrent();
    const task = session?.learning?.learningLab?.tasks?.find(item => item.id === session.learning.learningLab.currentTaskId);
    const decision = callCore('authorize', { actor, action: name, scopeId: ctx.scopeId,
      targetScopeId: input?.sessionId ? scopeOf(input.sessionId) : ctx.scopeId,
      generation: ctx.generation, currentGeneration: generation(ctx.scopeId),
      taskId: input?.taskId, currentTaskId: task?.id, diagnosticActive: !!task && !['passed', 'independent'].includes(task.status) });
    reserve('tool', 0, name);
    if (!decision.ok) {
      event('action_rejected', { tool: name, actor, code: decision.code });
      reserve('repair', 0, name);
      return { error: decision.reason, code: decision.code };
    }
    event('tool_started', { tool: name, actor });
    // Each tool receives an isolated learning draft. Reading the app while a
    // slow tool is running never exposes a mutation that has not been committed.
    const draft = { ...session, learning: clone(session?.learning), exam: clone(session?.exam) };
    const actionKey = 'tool:' + name + ':' + hash(input || {});
    // Only completed actions which actually changed learning are replayed.
    // Read/search calls remain fresh. A resumed run walks its ancestor chain.
    let runId = ctx.id;
    for (let depth = 0; runId && depth < 40; depth++) {
      const saved = db().prepare("SELECT result_json FROM harness_actions WHERE run_id=? AND action_key=? AND status='completed'").get(runId, actionKey);
      if (saved) { event('tool_replayed', { tool: name, replayed: true }); return JSON.parse(saved.result_json); }
      runId = db().prepare('SELECT resume_of FROM harness_runs WHERE id=?').get(runId)?.resume_of;
    }
    try {
      const before = hash({ learning: session?.learning, exam: session?.exam });
      const result = await fn(draft);
      assertCurrent();
      if (before !== hash({ learning: draft.learning, exam: draft.exam })) {
        commitBusiness({ key: actionKey, tool: name, input, result }, () => sessionStore.save(draft));
        // Keep references captured by the existing core/tools alive. Only
        // publish the committed draft; failed commits never touch these objects.
        for (const field of ['learning', 'exam']) {
          if (session[field] && draft[field] && typeof session[field] === 'object' && !Array.isArray(session[field])) {
            for (const key of Object.keys(session[field])) delete session[field][key];
            Object.assign(session[field], draft[field]);
          } else session[field] = draft[field];
        }
        for (const key of ['scopeRevision', 'scopeGeneration']) if (draft[key] !== undefined) session[key] = draft[key];
      }
      // Presentation flags live only for this turn, but the existing UI adapter
      // still needs them (for example the interactive card selected by a tool).
      for (const [key, value] of Object.entries(draft)) if (key.startsWith('_')) session[key] = value;
      event('tool_finished', { tool: name, actor, code: result?.code, verified: result?.verified });
      return result;
    }
    catch (err) { event('tool_failed', { tool: name, code: err.code || 'tool_failed' }); throw err; }
  };
  const result = ctx.queue.then(work);
  ctx.queue = result.catch(() => {});
  return result;
}
function cancelRun(runId, sessionId) {
  const row = ownedRun(runId, sessionId), ctx = active.get(row.id);
  if (ctx) ctx.controller.abort(error('cancelled', 'The run was cancelled.', 409));
  else if (row.status === 'interrupted') { db().prepare("UPDATE harness_runs SET status='cancelled',stop_reason='cancelled',updated_at=? WHERE id=?").run(Date.now(), row.id); event('run_stopped', { status: 'cancelled', stopReason: 'cancelled' }, row.id); }
  return { ok: true, run: publicRun(db().prepare('SELECT * FROM harness_runs WHERE id=?').get(row.id)) };
}
function resumeOptions(runId, sessionId) {
  let row = ownedRun(runId, sessionId);
  for (let depth = 0; depth < 20; depth++) { const child = db().prepare('SELECT * FROM harness_runs WHERE resume_of=? ORDER BY created_at DESC LIMIT 1').get(row.id); if (!child) break; row = child; }
  if (row.status === 'running' || row.status === 'completed') return { existing: publicRun(row), result: row.result_json ? JSON.parse(row.result_json) : null };
  if (!['interrupted', 'failed', 'cancelled'].includes(row.status)) throw error('run_not_resumable', 'This run cannot be resumed.');
  const state = sessionStore.scopeVersion?.(row.scope_id);
  if (state && (row.state_revision !== state.revision || row.state_generation !== state.generation)) throw error('resume_state_changed', 'Learning changed after this checkpoint. Start a new request.');
  if (Date.now() >= (budgetOf(row.budget_group_id)?.deadline || 0)) throw error('deadline_exceeded', 'The original deadline has passed.', 429);
  let original = row;
  for (let depth = 0; original.resume_of && depth < 100; depth++) {
    const parent = db().prepare('SELECT * FROM harness_runs WHERE id=?').get(original.resume_of);
    if (!parent) break;
    original = parent;
  }
  return { sessionId: row.session_id, courseId: row.course_id, kind: row.kind, input: JSON.parse(row.input_json), triggerId: 'resume:' + row.id, resumeOf: row.id, requestId: original.trigger_id };
}
function invalidateScope(scopeId) {
  const scope = scopeOf(scopeId);
  for (const ctx of active.values()) if (ctx.scopeId === scope) { ctx.invalidated = true; ctx.controller.abort(error('scope_deleted', 'This learning scope was deleted.', 410)); }
  db().transaction(() => {
    generation(scope);
    db().prepare('UPDATE harness_scopes SET generation=generation+1 WHERE scope_id=?').run(scope);
    for (const row of db().prepare('SELECT id FROM harness_runs WHERE scope_id=?').all(scope)) {
      for (const table of ['harness_events', 'harness_actions', 'harness_calls']) db().prepare(`DELETE FROM ${table} WHERE run_id=?`).run(row.id);
    }
    db().prepare('DELETE FROM harness_runs WHERE scope_id=?').run(scope);
    db().prepare('DELETE FROM harness_budgets WHERE scope_id=?').run(scope);
  })();
}
function invalidateCourse(courseId) {
  const scopes = db().prepare('SELECT DISTINCT scope_id FROM harness_runs WHERE course_id=?').all(String(courseId));
  for (const row of scopes) invalidateScope(row.scope_id);
}
function isControlError(err) { return ['budget_exhausted', 'deadline_exceeded', 'run_finished', 'scope_deleted', 'cancelled'].includes(err?.code) || currentSignal()?.aborted; }
async function optionalMaintenance(label, fn) {
  if (!current()) return fn();
  assertCurrent();
  const child = { label: safeText(label, 80), exhausted: false };
  event('maintenance_started', { label: child.label });
  return maintenance.run(child, async () => {
    try {
      const result = await fn();
      currentSignal()?.throwIfAborted();
      event(child.exhausted ? 'maintenance_skipped' : 'maintenance_completed', { label: child.label, ...(child.exhausted ? { code: 'budget_exhausted' } : {}) });
      return result;
    } catch (err) {
      currentSignal()?.throwIfAborted();
      if (err.code === 'budget_exhausted' && !current()?.budgetBlocked) {
        event('maintenance_skipped', { label: child.label, code: 'budget_exhausted' });
        return null;
      }
      throw err;
    }
  });
}
module.exports = { VERSION, withRun, current, currentSignal, configValue, assertCurrent, event, finishReason, commitBusiness, executeTool, meteredFetch,
  reserve, settle, getRun, listRuns, cancelRun, resumeOptions, invalidateScope, invalidateCourse, isControlError, optionalMaintenance, callCore, scopeOf };
