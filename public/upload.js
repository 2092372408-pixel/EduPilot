/* ============ EduPilot · 上传页逻辑（批量上传素材） ============ */
/* 会话与主页共享 uid：上传不绑定对话，仅用于回到主页 ?course= 直达 */
const UID = localStorage.getItem('eduowl_uid') || ('demo-' + Date.now());
localStorage.setItem('eduowl_uid', UID);

const $ = (id) => document.getElementById(id);
const { escapeHtml } = EduMarkdown;

const OK_EXT = /\.(md|markdown|txt|json|docx|pdf|pptx)$/i;
const EXT_LABEL = { '.md': 'Markdown', '.markdown': 'Markdown', '.txt': ui("文本"), '.json': 'JSON', '.docx': 'Word', '.pdf': 'PDF', '.pptx': 'PPT' };
// 单文件上限：默认 10MB，启动时从 /api/config 覆盖为后端实际值（UPLOAD_MAX_MB 可改）。
// 这条限制主要不是为了存储，而是**处理耗时**：解析＋切块＋向量化，实测 1MB≈46s、5MB≈228s。
let MAX_MB = 10;
let MAX_BYTES = MAX_MB * 1024 * 1024;

let files = []; // { file, state: 'queued'|'running'|'ok'|'err', msg }
let uploading = false;
let importedCourseId = '';

/* ---------- 文件列表渲染 ---------- */
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function addFiles(list) {
  if (uploading) return;
  const dz = $('dropzone');
  for (const f of list) {
    if (!OK_EXT.test(f.name)) { alert(`${ui("跳过不支持的文件：")}${f.name}${ui("（支持 docx/pdf/pptx/md/txt/json）")}`); continue; }
    if (f.size > MAX_BYTES) { alert(`${ui("文件过大：")}${f.name}${ui("（")}${fmtSize(f.size)}${ui("，超过 ")}${MAX_MB}${ui("MB 上限）。\n请压缩或拆分成多个文件后重新上传。")}`); continue; }
    // 去重：同名同大小视为重复
    if (files.some((x) => x.file.name === f.name && x.file.size === f.size)) continue;
    files.push({ file: f, state: 'queued', msg: ui("等待上传") });
  }
  renderList();
  if (files.length && !uploading) $('startBtn').disabled = false;
  $('clearBtn').disabled = !files.length;
  if (files.length) dz.style.display = 'none'; else dz.style.display = '';
}
function renderList() {
  const box = $('fileList');
  box.innerHTML = '';
  const stateMap = { queued: ui("⏳ 排队中"), running: ui("⏳ 解析中…"), ok: ui("✅ 完成"), err: ui("❌ 失败") };
  files.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    const ext = it.file.name.match(/\.[^.]+$/)?.[0].toLowerCase() || '';
    const p = it.progress;
    const elapsed = it.state === 'running' ? ui(' · 已用 ') + Math.floor((Date.now() - it.startedAt) / 1000) + ui(' 秒') : '';
    const detail = p && p.chunkCount !== undefined
      ? ui('课程结构：') + p.chapterCount + ui(' 章 / ') + p.sectionCount + ui(' 节 / ') + p.chunkCount + ui(' 块')
        + (p.reused ? ui('，复用 ') + p.reused + ui(' 块') : '') : '';
    row.innerHTML =
      `<span class="name">📄 ${escapeHtml(it.file.name)} <small style="color:var(--text-2)">(${EXT_LABEL[ext] || ui("文件")})</small></span>` +
      `<span class="size">${fmtSize(it.file.size)}</span>` +
      `<span class="state ${it.state === 'ok' ? 'ok' : it.state === 'err' ? 'err' : it.state === 'running' ? 'run' : ''}">${it.state === 'err' ? '❌ ' + escapeHtml(it.msg) : it.state === 'running' ? escapeHtml(it.msg + elapsed) : stateMap[it.state]}</span>` +
      (uploading ? '' : `<button class="rm" data-i="${i}${ui("\" title=\"移除\">✕</button>")}`) +
      (it.state === 'running' ? `<progress class="file-progress" aria-label="${ui('当前阶段进度')}" ${p && ['embedding', 'generating'].includes(p.stage) && p.total > 0 ? `max="${p.total}" value="${p.completed}"` : ''}></progress>` : '') +
      (detail ? `<span class="file-detail">${escapeHtml(detail)}</span>` : '');
    box.appendChild(row);
  });
  box.querySelectorAll('.rm').forEach((b) => b.addEventListener('click', () => {
    files.splice(+b.dataset.i, 1);
    renderList();
    $('startBtn').disabled = !files.length;
    $('clearBtn').disabled = !files.length;
    if (!files.length) $('dropzone').style.display = '';
  }));
  const done = files.filter((f) => f.state === 'ok').length;
  const bad = files.filter((f) => f.state === 'err').length;
  const total = files.length;
  $('upBar').style.width = total ? Math.round(((done + bad) / total) * 100) + '%' : '0';
  $('upProgress').setAttribute('aria-valuenow', done + bad);
  $('upProgress').setAttribute('aria-valuemax', total || 1);
  const running = files.find((f) => f.state === 'running');
  $('upProgressText').textContent = ui('已处理 ') + (done + bad) + '/' + total + ui(' 个文件') + (running ? ' · ' + running.msg : '');
}
function setState(i, state, msg) {
  files[i].state = state;
  files[i].msg = msg || '';
  if (state === 'running') {
    files[i].startedAt = Date.now();
    files[i].progress = { stage: 'uploading' };
  }
  renderList();
}

function progressText(p) {
  if (p.stage === 'generating') return ui('正在生成教学讲义和题目 ') + p.completed + '/' + p.total + ui(' 节') + (p.title ? ' · ' + p.title : '');
  if (p.stage === 'embedding') {
    return p.total ? ui('正在向量化 ') + p.completed + '/' + p.total + ui(' 块') : ui('复用已有向量');
  }
  return {
    uploading: ui('正在上传文件…'), parsing: ui('正在解析文档…'), structuring: ui('正在识别章节…'),
    chunking: ui('正在按章节切块…'), saving: ui('正在保存课程与索引…'),
  }[p.stage] || ui('处理中…');
}

async function readUploadResponse(res, onProgress) {
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch (_) { /* use the HTTP error below */ }
    if (res.ok && data && data.ok) return data;
    const fallback = res.status === 413
      ? ui('文件过大：超过 ') + MAX_MB + ui('MB 上限，请压缩或拆分后重新上传')
      : ui('上传失败（HTTP ') + res.status + ui('）') + (raw ? ui('：') + raw.slice(0, 120) : '');
    throw new Error((data && data.error) || fallback);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const type = /^event:\s*(.+)$/m.exec(block)?.[1];
        const lines = block.split('\n').filter((line) => line.startsWith('data:'));
        if (!lines.length) continue; // heartbeat comments
        const data = JSON.parse(lines.map((line) => line.slice(5).trimStart()).join('\n'));
        if (type === 'progress') onProgress(data);
        if (type === 'error') throw new Error(data.error || ui('上传失败'));
        if (type === 'done' && data.ok) return data;
      }
    }
    throw new Error(ui('连接中断，未收到处理结果；请先检查课程列表再重试'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/* ---------- 已有课程（追加模式） ---------- */
async function loadAppendOptions() {
  const sel = $('appendSelect');
  sel.innerHTML = '';
  let courses = [];
  try { courses = (await (await eduFetch('/api/courses')).json()).courses || []; } catch (_) {}
  const dyn = courses.filter((c) => c.source === 'upload');
  if (!dyn.length) {
    $('appendSelect').classList.add('hidden');
    return;
  }
  sel.classList.toggle('hidden', document.querySelector('input[name="mode"]:checked').value !== 'append');
  dyn.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.title}${ui("（")}${c.chapterCount}${ui(" 章 / ")}${c.chunkCount}${ui(" 块）")}`;
    sel.appendChild(o);
  });
}
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
  const append = $('appendSelect');
  const mode = document.querySelector('input[name="mode"]:checked').value;
  append.classList.toggle('hidden', mode !== 'append');
  $('titleRow').style.display = mode === 'append' ? 'none' : '';
}));

/* ---------- 上传执行（串行，批量追加到同一门课） ---------- */
async function startUpload() {
  if (uploading || !files.length) return;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode === 'append' && !$('appendSelect').value) {
    $('statusTip').textContent = ui("请选择已有课程，或切换为新建课程");
    return;
  }
  uploading = true;
  $('startBtn').disabled = true;
  $('clearBtn').disabled = true;
  $('statusTip').textContent = ui("上传中，请勿关闭页面…");
  $('upProgress').classList.remove('hidden');
  $('upProgressText').classList.remove('hidden');
  const elapsedTimer = setInterval(renderList, 1000);

  const customTitle = $('courseTitleInput').value.trim();
  const appendCourseId = mode === 'append' ? $('appendSelect').value : '';
  const results = files.filter(it => it.state === 'ok').map(it => it.result);

  // 第一个文件决定课程（新建传 title；追加传 courseId）
  let firstCourseId = importedCourseId || appendCourseId;
  try {
    for (let i = 0; i < files.length; i++) {
      const it = files[i];
      if (it.state === 'ok') continue;
      setState(i, 'running', progressText({ stage: 'uploading' }));
      try {
        const params = new URLSearchParams({ filename: it.file.name });
        if (firstCourseId) params.set('courseId', firstCourseId);
        if (!firstCourseId && customTitle) params.set('title', customTitle);
        const res = await eduFetch('/api/kb/upload?' + params.toString(), {
          method: 'POST',
          headers: { 'X-Filename': encodeURIComponent(it.file.name), Accept: 'text/event-stream' },
          body: it.file,
        });
        const data = await readUploadResponse(res, (p) => {
          it.progress = { ...it.progress, ...p };
          it.msg = progressText(p);
          renderList();
        });
        if (!firstCourseId) firstCourseId = data.courseId; // 后续文件都并入这一门课
        importedCourseId = firstCourseId;
        it.result = data;
        setState(i, 'ok', `+${data.chunkCount}${ui(" 块")}`);
        results.push(data);
      } catch (e) {
        setState(i, 'err', e.message);
        results.push({ error: e.message, filename: it.file.name });
      }
    }
  } finally {
    clearInterval(elapsedTimer);
    uploading = false;
    $('clearBtn').disabled = false;
    $('startBtn').disabled = !files.some(it => it.state === 'err');
    $('startBtn').textContent = files.some(it => it.state === 'err') ? ui('重试失败文件') : ui('开始上传');
    renderList();
    $('statusTip').textContent = '';
  }

  // 汇总
  const ok = results.filter((r) => !r.error);
  const bad = results.filter((r) => r.error);
  const last = ok[ok.length - 1];
  const sum = $('summary');
  sum.classList.remove('hidden', 'err');
  const lines = [];
  if (last) {
    lines.push(`${ui("✅ 已")}${mode === 'append' ? ui("追加到") : ui("创建")}${ui("课程《")}${last.title}${ui("》（")}${last.bookCount}${ui(" 篇素材 / ")}${last.chapterCount}${ui(" 章 / ")}${last.chunkCount}${ui(" 块可检索内容）")}`); // 摘要按纯文本渲染，不加 markdown 记号
    if (ok.length > 1) lines.push(`${ui("📦 本批共 ")}${ok.length}${ui(" 个文件，全部合并到这门课。")}`);
    if (last.learningReady) lines.push(ui('📖 教学讲义和题目已就绪，可直接开始预习、学习和复习。'));
  } else {
    sum.classList.add('err');
    lines.push(ui("❌ 没有文件上传成功，课程未创建。"));
  }
  if (bad.length) lines.push(`⚠️ ${bad.length}${ui(" 个文件失败：")}${bad.map((b) => b.filename + ui("：") + (b.error || '')).join(ui("；"))}`);
  if (bad.length) lines.push(ui('点击“重试失败文件”继续；已成功的文件会保留。'));
  [...new Set(ok.flatMap((r) => r.warnings || []))].forEach((warning) => lines.push('⚠️ ' + warning));
  sum.innerHTML = lines.map(escapeHtml).join('<br/>');
  $('upProgress').classList.add('hidden');
  $('upProgressText').classList.add('hidden');

  // 完成：去上课 / 回主页
  if (last) {
    const go = document.createElement('div');
    go.style.marginTop = '10px';
    go.innerHTML = `${ui("<button class=\"btn-primary\" id=\"goCourseBtn\">📚 进入《")}${escapeHtml(last.title)}${ui("》</button>\n      <a href=\"/\" class=\"btn-ghost small\" style=\"margin-left:8px;\">返回主页</a>")}`;
    sum.appendChild(go);
    $('goCourseBtn').addEventListener('click', () => { location.href = eduUrl('/?course=' + encodeURIComponent(last.courseId)); });
  }
}

/* ---------- 事件绑定 ---------- */
$('dropzone').addEventListener('click', () => $('fileInput').click());
$('dropzone').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
});
$('fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
['dragover', 'dragenter'].forEach((ev) => $('dropzone').addEventListener(ev, (e) => { e.preventDefault(); $('dropzone').classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => $('dropzone').addEventListener(ev, (e) => { e.preventDefault(); $('dropzone').classList.remove('over'); }));
$('dropzone').addEventListener('drop', (e) => { addFiles([...e.dataTransfer.files]); });
$('startBtn').addEventListener('click', startUpload);
$('clearBtn').addEventListener('click', () => {
  if (uploading) return;
  files = [];
  importedCourseId = '';
  renderList();
  $('startBtn').disabled = true;
  $('clearBtn').disabled = true;
  $('dropzone').style.display = '';
  $('summary').classList.add('hidden');
  $('statusTip').textContent = ui("先选择文件");
});

/* ---------- 服务端约束（上传上限） ---------- */
// 取后端 MAX_MB 覆盖前端默认值：UPLOAD_MAX_MB 调整后，界面提示与实际校验始终一致。
async function loadConfig() {
  try {
    const cfg = await (await eduFetch('/api/config')).json();
    if (cfg && Number(cfg.uploadMaxMB) > 0) {
      MAX_MB = Number(cfg.uploadMaxMB);
      MAX_BYTES = Number(cfg.uploadMaxBytes) || MAX_MB * 1024 * 1024;
      const hint = document.querySelector('.dz-sub');
      if (hint) hint.textContent = `${ui("支持 docx / pdf / pptx / md / txt / json，单个 ≤ ")}${MAX_MB}${ui("MB（超限请压缩或拆分）")}`;
    }
  } catch (_) { /* 用默认 10MB */ }
}

// 来自主页 ?course= 直达 → 预选"追加到该课程"
(async function prefill() {
  await Promise.all([loadConfig(), loadAppendOptions()]);
  const from = new URLSearchParams(location.search).get('course');
  if (from && from.startsWith('user-')) {
    const sel = $('appendSelect');
    if ([...sel.options].some((o) => o.value === from)) {
      document.querySelector('input[name="mode"][value="append"]').checked = true;
      sel.value = from;
      sel.classList.remove('hidden');
      $('titleRow').style.display = 'none';
    }
  }
})();
