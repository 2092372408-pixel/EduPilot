/**
 * practice-card.js — 对话内练习卡片（题组：逐题作答 + 每题可问）
 * ------------------------------------------------------------------
 * 由 app.js 的 addPracticeCard 调用；题组结构来自后端 buildPracticePayload：
 *   { type:'practice', kpId, kpTitle, reason, items:[ {type:'choice'|'coding', ...} ] }
 * 行为：
 *   - 一次显示一题，答完出现「下一题 →」；最后一题答完提示并给「再来几题」
 *   - 选择题：点选项即判分并记录；编程题：可运行 / 提交判分 / 问一下
 *   - 每题都有「让 EduPilot 讲讲」→ 带着题目上下文回到对话，学习向导给针对性提示
 * 兼容旧格式 { question, problem }（单题卡片）。
 */
(function (root) {
  'use strict';

  /** 旧格式 → items 数组 */
  function normalizeItems(data) {
    if (Array.isArray(data.items) && data.items.length) return data.items;
    const items = [];
    if (data.question) items.push({ type: 'choice', kpId: data.kpId, kpTitle: data.kpTitle, ...data.question });
    if (data.problem) {
      items.push({
        type: 'coding', kpId: data.kpId, kpTitle: data.kpTitle,
        problemId: data.problem.id, title: data.problem.title, difficulty: data.problem.difficulty,
        description: data.problem.description, starterCode: data.problem.starterCode,
      });
    }
    return items;
  }

  function render(data, api) {
    const items = normalizeItems(data || {});
    if (!items.length) return;
    const esc = api.escapeHtml;
    const wrap = document.createElement('div');
    wrap.className = 'msg bot';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.innerHTML = api.brandAvatar;
    const bubble = document.createElement('div');
    bubble.className = 'bubble card-bubble';
    const head = '🎯 ' + esc(data.reason || ui("练一练")) + (data.kpTitle ? ' · ' + esc(data.kpTitle) : '')
      + (items.length > 1 ? `${ui("　")}${items.length}${ui(" 题")}` : '');
    bubble.innerHTML = `<div class="card-head">${head}</div><div class="card-progress"></div><div class="card-body"></div><div class="card-foot"></div>`;
    wrap.append(avatar, bubble);
    api.container.appendChild(wrap);
    api.scrollToBottom();

    const body = bubble.querySelector('.card-body');
    const progressEl = bubble.querySelector('.card-progress');
    const footEl = bubble.querySelector('.card-foot');
    // 正式测验卡片：题号要接着整场测验的进度显示（如"第 3 / 5 题"），而不是从 1 数
    const official = !!data.official;
    const baseIdx = official && Number.isFinite(data.answered) ? data.answered : 0;
    const totalN = official && Number.isFinite(data.total) ? data.total : items.length;
    let idx = 0;

    function step() {
      const item = items[idx];
      body.innerHTML = '';
      progressEl.textContent = totalN > 1 ? `${ui("第 ")}${baseIdx + idx + 1} / ${totalN}${ui(" 题")}` : '';
      footEl.innerHTML = '';
      if (item.type === 'coding') renderCoding(item);
      else renderChoice(item);
      api.scrollToBottom();
    }

    /** 答完当前题：还有下一题就给按钮，最后一题给收尾 */
    function advance() {
      footEl.innerHTML = '';
      if (idx + 1 < items.length) {
        const btn = document.createElement('button');
        btn.className = 'card-next';
        btn.textContent = ui("下一题 →");
        btn.addEventListener('click', () => { idx += 1; step(); });
        footEl.appendChild(btn);
      } else {
        const tip = document.createElement('div');
        tip.className = 'card-done';
        tip.textContent = items.length > 1 ? ui("这一组练完了 👍 需要更多可以再来一组") : ui("练完了 👍");
        const more = document.createElement('button');
        more.className = 'card-more';
        more.textContent = ui("再来几题");
        more.addEventListener('click', () => api.sendMessage(ui("练习更多")));
        footEl.append(tip, more);
      }
    }

    function renderChoice(item) {
      const kpId = item.kpId || data.kpId || '';
      const ctx = {
        kpId, kpTitle: item.kpTitle || data.kpTitle,
        question: { q: item.q, options: item.options, answer: item.answer, explanation: item.explanation },
      };      const block = document.createElement('div');
      block.className = 'card-block';
      block.innerHTML =
        (item.kpTitle && item.kpTitle !== data.kpTitle ? `<div class="card-kp">${esc(item.kpTitle)}</div>` : '') +
        '<div class="card-q">📝 ' + esc(item.q) + '</div>' +
        '<div class="card-opts">' + (item.options || []).map((opt, i) =>
          '<button class="card-opt" data-idx="' + i + '">' + String.fromCharCode(65 + i) + '. ' + esc(opt) + '</button>').join('') + '</div>' +
        '<div class="card-fb hidden"></div>' +
        ui("<div class=\"card-ask-row\"><button class=\"card-explain hidden\">💬 让 EduPilot 讲讲这题</button></div>");
      body.appendChild(block);

      const opts = block.querySelectorAll('.card-opt');
      const fb = block.querySelector('.card-fb');
      const explainBtn = block.querySelector('.card-explain');
      let answered = false;
      opts.forEach((btn) => {
        btn.addEventListener('click', () => {
          if (answered || !api.canInteract()) return;
          answered = true;
          opts.forEach((b) => (b.disabled = true));
          const letter = String.fromCharCode(65 + parseInt(btn.dataset.idx, 10));
          const correct = letter === item.answer;
          if (correct) btn.classList.add('right');
          else {
            btn.classList.add('wrong');
            opts.forEach((b) => { if (b.textContent.startsWith(item.answer + '.')) b.classList.add('right'); });
          }
          fb.classList.remove('hidden');
          fb.innerHTML = (correct ? ui("✅ 回答正确！") : ui("❌ 正确答案是 ") + item.answer + ui("。"))
            + (item.explanation ? '<br/>💡 ' + esc(item.explanation) : '');
          explainBtn.classList.remove('hidden');
          ctx.userAnswer = letter;
          ctx.submitted = true;
          // 明确记录对错：LLM 答疑要据此说清"你哪里想错了"，
          // 只传"已作答"会让模型把答错的题说成"答对了"（自相矛盾）。
          ctx.correct = correct;
          ctx.userAnswerText = (item.options || [])[parseInt(btn.dataset.idx, 10)] || '';
          api.recordAnswer(kpId, { kind: 'choice', kpId, question: item.q, userAnswer: letter, correct, explanation: item.explanation, replay: !!data.replay }, fb);
          advance();
        });
      });
      explainBtn.addEventListener('click', () => api.askExplain(ctx));
    }

    function renderCoding(item) {
      const kpId = item.kpId || data.kpId || '';
      const ctx = { kpId, kpTitle: item.kpTitle || data.kpTitle, problemTitle: item.title };
      const block = document.createElement('div');
      block.className = 'card-block';
      block.innerHTML =
        ui("<div class=\"card-q\">🖥 编程挑战 · ") + esc(item.title) + (item.difficulty ? ui("（") + esc(item.difficulty) + ui("）") : '') + '</div>' +
        '<div class="card-desc">' + esc(item.description || '').replace(/\n/g, '<br/>') + '</div>' +
        '<textarea class="card-code" spellcheck="false">' + esc(item.starterCode || '') + '</textarea>' +
        ui("<div class=\"card-actions\"><button class=\"card-run\">▶ 运行</button><button class=\"card-submit\">提交判分</button><button class=\"card-explain-card\">💬 问一下</button></div>") +
        '<pre class="card-output hidden"></pre><div class="card-grade hidden"></div>';
      body.appendChild(block);

      const codeEl = block.querySelector('.card-code');
      const outEl = block.querySelector('.card-output');
      const gradeEl = block.querySelector('.card-grade');

      block.querySelector('.card-run').addEventListener('click', async () => {
        outEl.classList.remove('hidden');
        gradeEl.classList.add('hidden');
        outEl.textContent = ui("⏳ 运行中…");
        try {
          const r = await (await eduFetch('/api/run/python', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: codeEl.value }),
          })).json();
          if (r.rejected) outEl.textContent = '🚫 ' + (r.error || ui("被拦截"));
          else if (r.timeout) outEl.textContent = '⏱️ ' + (r.error || ui("运行超时"));
          else if (r.stderr.trim()) outEl.textContent = r.stderr;
          else outEl.textContent = r.stdout || ui("（无输出）");
          ctx.code = codeEl.value;
          ctx.lastRun = { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode };
        } catch (e) { outEl.textContent = ui("⚠️ 请求失败"); }
      });

      block.querySelector('.card-submit').addEventListener('click', async (e) => {
        if (!api.canInteract()) return;
        const button = e.currentTarget;
        button.disabled = true;
        gradeEl.classList.remove('hidden');
        gradeEl.innerHTML = ui("<div class=\"card-grade-loading\">⏳ 判分中…</div>");
        try {
          const r = await (await eduFetch('/api/coding/submit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: api.sessionId, kpId, problemId: item.problemId || item.id, code: codeEl.value }),
          })).json();
          if (r.error) { gradeEl.innerHTML = '⚠️ ' + esc(r.error); return; }
          const allPass = r.passed === r.total;
          const cases = r.results.map((c) => '<div>' + (c.pass ? '<span style="color:#3b6d11">✓</span>' : '<span style="color:#a32d2d">✗</span>') + ' ' + esc(c.desc) + '</div>').join('');
          gradeEl.innerHTML = ui("<div class=\"card-grade-title\">提交结果：") + r.passed + ' / ' + r.total + ui(" 用例通过") + (allPass ? ' 🎉' : '') + '</div>'
            + '<div class="card-grade-cases">' + cases + '</div>'
            + (r.review && r.review.comment ? '<div class="card-grade-comment">' + esc(r.review.comment) + '</div>' : '');
          ctx.submitted = allPass;
          ctx.code = codeEl.value;
          if (api.onGraded) await api.onGraded();
          advance();
        } catch (e) { gradeEl.innerHTML = ui("⚠️ 判分请求失败"); }
        finally { button.disabled = false; }
      });

      block.querySelector('.card-explain-card').addEventListener('click', () => {
        ctx.code = codeEl.value;
        api.askExplain(ctx);
      });
    }

    step();
  }

  root.EduPracticeCard = { render, normalizeItems };
})(typeof self !== 'undefined' ? self : this);
