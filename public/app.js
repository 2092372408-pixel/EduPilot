/* ============ EduPilot · 前端逻辑 ============ */
/* 会话体系（课程独立）：
   - uid：本机用户标识（localStorage 持久），所有课程共享；
   - 每门课一个独立会话：sessionId = `${uid}@${courseId}`
     → 对话框历史 / 学习进度 / 记忆 按课程天然隔离（服务端 session 维度）；
   - 当前课程记忆在 localStorage（eduowl_course），支持 ?course=xxx 直达。
*/
const UID = localStorage.getItem('eduowl_uid') || ('demo-' + Date.now());
localStorage.setItem('eduowl_uid', UID);

function sessionIdFor(courseId) {
  return `${UID}@${courseId}`;
}
function currentCourseId() {
  const fromUrl = new URLSearchParams(location.search).get('course');
  return (fromUrl || localStorage.getItem('eduowl_course') || 'python-intro');
}
function setCurrentCourse(courseId) {
  localStorage.setItem('eduowl_course', courseId);
  // 清理 URL 参数，避免刷新时被 ?course= 覆盖
  const url = new URL(location.href);
  url.searchParams.delete('course');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function langParam() { return '&lang=' + eduLanguage(); }
let SESSION_ID = sessionIdFor(currentCourseId()); // 当前课程的会话 id（切课更新）
let courseData = null;
let learning = null;
let isDynamicCourse = false; // 用户上传素材课程
// 联网开关（输入框左下角单键）：关=off（不联网）/ 开=on（本轮必联网）。
// 服务端另支持 'auto'（由 Agent 判断），此处不暴露给用户，保持"一键开关"的简单心智。
let webOn = false;
let webConfigState = { enabled: false, hasKey: false, keyMasked: '', ready: false };
let pendingFiles = [];

const $ = (id) => document.getElementById(id);

/* ============ 通用确认框（替代原生 confirm：内嵌浏览器/部分环境会拦截原生弹窗） ============ */
let confirmResolve = null;
let confirmWantsInput = false;
function showConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmWantsInput = !!opts.input;
    $('confirmTitle').textContent = opts.title || ui("确认操作");
    $('confirmMsg').textContent = message;
    $('confirmOkBtn').textContent = opts.okText || ui("确定");
    const inp = $('confirmInput');
    inp.classList.toggle('hidden', !confirmWantsInput);
    if (confirmWantsInput) inp.value = opts.inputValue || '';
    $('confirmOverlay').classList.remove('hidden');
    setTimeout(() => (confirmWantsInput ? inp : $('confirmOkBtn')).focus(), 30);
  });
}
function closeConfirm(result) {
  $('confirmOverlay').classList.add('hidden');
  const val = confirmWantsInput ? $('confirmInput').value : '';
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(result ? { ok: true, value: val } : { ok: false, value: '' }); }
}

/* ============ 联网开关（DeepSeek 式单键，按课程记忆） ============ */
function webModeKey() { return 'eduowl_webmode:' + currentCourseId(); }
/** 渲染开关外观：开启=紫色实心 */
function renderWebToggle() {
  const btn = $('webToggle');
  if (!btn) return;
  const available = webConfigState.ready && webConfigState.enabled && webConfigState.hasKey;
  btn.disabled = !available;
  btn.classList.toggle('is-on', webOn);
  btn.setAttribute('aria-pressed', webOn ? 'true' : 'false');
  const txt = btn.querySelector('.web-txt');
  if (txt) txt.textContent = webOn ? ui("联网中") : ui("联网");
  btn.title = !available
    ? ui("联网搜索未启用：请先在设置中打开并配置 Tavily API Key")
    : webOn
    ? ui("联网搜索已开启：回答会先检索教材外的最新资料（点击关闭）")
    : ui("点击开启联网搜索：教材外的实时信息将走 MCP 检索");
}
function setWebOn(on, { persist = true } = {}) {
  const available = webConfigState.ready && webConfigState.enabled && webConfigState.hasKey;
  webOn = !!on && available;
  renderWebToggle();
  if (!persist) return;
  localStorage.setItem(webModeKey(), webOn ? 'on' : 'off');
  // 同步到服务端会话偏好（失败不阻断，本地已记住）
  eduFetch('/api/webmode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, webMode: webOn ? 'on' : 'off' }),
  }).catch(() => {});
}
function initWebToggle() {
  const btn = $('webToggle');
  if (btn) btn.addEventListener('click', () => setWebOn(!webOn));
  setWebOn(localStorage.getItem(webModeKey()) === 'on', { persist: false });
}

function renderWebSettings(config) {
  webConfigState = { ...(config || {}), ready: true };
  const enabled = $('webEnabled');
  const key = $('webApiKey');
  const hint = $('webKeyHint');
  if (enabled) enabled.checked = !!webConfigState.enabled;
  if (key) {
    key.value = '';
    key.type = 'password';
    $('webKeyToggle').textContent = ui('显示');
    key.placeholder = webConfigState.hasKey
      ? `${ui("已保存 ")}${webConfigState.keyMasked}${ui("（留空表示不修改）")}`
      : ui("粘贴你的 Tavily API Key");
  }
  if (hint) {
    hint.textContent = webConfigState.hasKey
      ? ui("已保存 Tavily API Key。留空可继续使用当前密钥。")
      : ui("尚未保存 Tavily API Key，配置后才可开启联网。");
  }
  webOn = webConfigState.enabled && webConfigState.hasKey && localStorage.getItem(webModeKey()) === 'on';
  renderWebToggle();
}

function webSettingsStatus(kind, message) {
  const status = $('webStatus');
  if (!status) return;
  status.className = 'llm-status' + (kind ? ` ${kind}` : '');
  status.textContent = message;
  status.classList.remove('hidden');
}

async function loadWebConfig() {
  try {
    const data = await api('/api/web/config');
    renderWebSettings(data.config || {});
    webSettingsStatus('', '');
    $('webStatus')?.classList.add('hidden');
    return { ok: true, config: data.config || {} };
  } catch (error) {
    webConfigState = { enabled: false, hasKey: false, ready: true };
    webOn = false;
    renderWebToggle();
    webSettingsStatus('err', ui("加载联网设置失败：") + error.message);
    return { ok: false, error: error.message };
  }
}

async function saveWebConfig() {
  const enabled = !!$('webEnabled')?.checked;
  const apiKey = $('webApiKey')?.value.trim() || undefined;
  webSettingsStatus('busy', ui("正在保存联网设置…"));
  try {
    const data = await api('/api/web/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, apiKey }),
    });
    renderWebSettings(data.config || {});
    webSettingsStatus('ok', ui("联网设置已保存"));
    return { ok: true, config: data.config || {} };
  } catch (error) {
    webSettingsStatus('err', ui("保存联网设置失败：") + error.message);
    return { ok: false, error: error.message };
  }
}

window.loadWebConfig = loadWebConfig;
window.saveWebConfig = saveWebConfig;

/* ============ 本地身份：昵称 + 头像（开始页引导，Agent 以此称呼） ============ */
const AVATARS = ['edupilot'];
let myProfile = null;      // { nickname, avatar }，null = 未设置
let selectedAvatar = null;

/** 拉取本机档案（uid 维度，非账号体系） */
async function loadProfile() {
  try {
    const d = await (await eduFetch(`/api/profile?uid=${encodeURIComponent(UID)}`)).json();
    myProfile = (d && d.profile) || null;
  } catch (_) { myProfile = null; }
  renderUserChip();
  return myProfile;
}

/** 顶栏 chip：有昵称则展示头像+昵称，否则隐藏 */
function renderUserChip() {
  const chip = $('userChip');
  if (myProfile && myProfile.nickname) {
    $('userAvatar').innerHTML = '<img src="/logo-mark.png" alt="EduPilot" />';
    $('userNick').textContent = myProfile.nickname;
    chip.classList.remove('hidden');
  } else {
    chip.classList.add('hidden');
  }
}

/** 欢迎语称呼前缀（如 "你好，小明！"；未设置则为空） */
function greetName() {
  return (myProfile && myProfile.nickname) ? `${eduLanguage() === 'en' ? ', ' : ui("，")}${myProfile.nickname}` : '';
}

/** 打开欢迎/资料卡：first=true 为首次引导（含欢迎标题） */
function openProfileCard(first) {
  const grid = $('avatarGrid');
  if (!grid.children.length) {
    AVATARS.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', ui("选择 EduPilot 标志作为头像"));
      b.className = 'avatar-opt';
      b.innerHTML = '<img src="/logo-mark.png" alt="EduPilot" />';
      b.dataset.avatar = a;
      b.addEventListener('click', () => {
        grid.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
        selectedAvatar = a;
      });
      grid.appendChild(b);
    });
  }
  // 默认选中：现有头像或第一个
  const cur = AVATARS[0];
  selectedAvatar = cur;
  grid.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected'));
  const curEl = grid.querySelector(`[data-avatar="${cur}"]`);
  if (curEl) curEl.classList.add('selected');
  $('nicknameInput').value = (myProfile && myProfile.nickname) || '';
  $('welcomeTitle').textContent = first ? ui("你好，我是 EduPilot 👋") : ui("编辑我的资料");
  $('welcomeSub').textContent = first ? ui("先告诉我怎么称呼你，我会一直记得") : ui("头像与昵称改动后，EduPilot 会以新称呼与你交流");
  $('saveProfileBtn').textContent = first ? ui("保存并") + window.t('startLearning') : ui("保存修改");
  $('skipProfileBtn').style.display = first ? '' : 'none';
  $('welcomeOverlay').classList.remove('hidden');
  document.querySelector('.app').inert = true;
  $('nicknameInput').focus();
}

function closeProfileCard() {
  $('welcomeOverlay').classList.add('hidden');
  // 配置向导可能还开着（首启会先弹配置、再弹资料卡）：此时不能解除 inert
  if (!$('llmOverlay').classList.contains('hidden')) return;
  document.querySelector('.app').inert = false;
  (myProfile ? $('userChip') : $('input')).focus();
  window.EduOnboarding.resume();
}

/** 保存档案（POST 到服务端 data/profiles.json） */
async function saveProfile() {
  const nickname = $('nicknameInput').value.trim();
  if (!nickname) {
    // 可见反馈：红框 + 副标题提示（避免"点了没反应"的困惑）
    const inp = $('nicknameInput');
    const sub = $('welcomeSub');
    inp.classList.add('input-warn');
    const prev = sub.textContent;
    sub.textContent = ui("⚠️ 先输入昵称，我才能记住怎么称呼你");
    sub.style.color = '#dc2626';
    inp.focus();
    setTimeout(() => {
      inp.classList.remove('input-warn');
      sub.textContent = prev;
      sub.style.color = '';
    }, 2200);
    return;
  }
  try {
    const res = await eduFetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: UID, nickname, avatar: selectedAvatar || AVATARS[0] }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || ui("保存失败"));
    myProfile = d.profile;
    renderUserChip();
    closeProfileCard();
    // 主界面欢迎问候带昵称：尚未对话（仅系统欢迎条）时补一条带称呼的问候，让用户立即感知称呼生效
    const msgBox = $('messages');
    const unspoken = msgBox && msgBox.children.length <= 1;
    if (unspoken) {
      addMessage('bot', `${ui("👋 你好")}${greetName()}${ui("！我是 **EduPilot**（AI 学习向导），从现在起我就这样称呼你啦～")}`);
    } else if (myProfile && myProfile.nickname && msgBox && msgBox.children.length > 1) {
      // 已聊过：轻提示称呼已生效，不打扰对话流
      addMessage('bot', `${ui("📝 已记住：我叫你「")}${myProfile.nickname}${ui("」")}`);
    }
  } catch (e) {
    alert(ui("保存失败：") + (e.message || ui("未知错误")));
  }
}

/* ---------- 统一 fetch 助手：检查 HTTP 状态、透传服务端错误（避免"成功了却报失败"类误导） ---------- */
async function api(path, opts = {}) {
  let res;
  try {
    res = await eduFetch(path, opts);
  } catch (e) {
    throw new Error(ui("网络错误：") + (e.message || ui("连接失败，请确认服务已启动")));
  }
  let data = {};
  try { data = await res.json(); } catch (_) { /* 非 JSON 响应 */ }
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/* ---------- 轻量 markdown 渲染（代码块/表格/标题/列表/粗体/行内代码/链接） ---------- */
const { escapeHtml, renderMarkdown } = EduMarkdown;

/* ---------- 品牌形象（EduPilot 学习向导 / 学生人形） ---------- */
const BRAND_AVATAR = '<img src="/logo-mark.png" alt="EduPilot" width="26" height="26" />';
const USER_SVG = '<svg viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="1.5" width="31" height="31" rx="10" fill="#e6e6e6"/><circle cx="17" cy="13.5" r="5.8" fill="#858585"/><path d="M7.5 29 a9.5 9.5 0 0 1 19 0 z" fill="#858585"/></svg>';

/* ---------- 消息气泡 ---------- */
function addMessage(role, content, { typing = false, attachments = [] } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}` + (typing ? ' typing' : '');
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.innerHTML = role === 'bot' ? BRAND_AVATAR : USER_SVG;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (typing) {
    bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  } else {
    bubble.innerHTML = renderMarkdown(content);
    if (attachments.length) {
      const files = document.createElement('div');
      files.className = 'message-attachments';
      files.innerHTML = attachments.map((file) => `<span class="message-attachment">📎 ${escapeHtml(file.name || file.original_name || ui('附件'))}</span>`).join('');
      bubble.prepend(files);
    }
    // 复制按钮（bot 消息 hover 显示）
    if (role === 'bot') {
      const copy = document.createElement('button');
      copy.className = 'copy-btn';
      copy.title = ui("复制回复");
      copy.setAttribute('aria-label', ui("复制回复"));
      copy.textContent = '⧉';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(content).then(() => {
          copy.textContent = '✓';
          setTimeout(() => (copy.textContent = '⧉'), 1200);
        }).catch(() => { copy.textContent = '!'; copy.title = ui("复制失败，请手动选择文字复制"); });
      });
      wrap.appendChild(copy);
    }
  }
  wrap.append(avatar, bubble);
  $('messages').appendChild(wrap);
  $('messages').scrollTop = $('messages').scrollHeight;
  return bubble;
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderPendingFiles() {
  const box = $('attachmentList');
  if (!box) return;
  box.innerHTML = '';
  pendingFiles.forEach((file, index) => {
    const item = document.createElement('span');
    item.className = 'attachment-pending';
    item.innerHTML = `<span class="attachment-name">${escapeHtml(file.name)}</span><span class="attachment-size">${formatFileSize(file.size)}</span>`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.textContent = '×';
    remove.title = ui('移除附件');
    remove.setAttribute('aria-label', ui('移除附件') + ' ' + file.name);
    remove.addEventListener('click', () => { pendingFiles.splice(index, 1); renderPendingFiles(); });
    item.appendChild(remove);
    box.appendChild(item);
  });
}

function chooseAttachments(files) {
  const incoming = Array.from(files || []);
  const seen = new Set(pendingFiles.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  incoming.forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!seen.has(key)) { pendingFiles.push(file); seen.add(key); }
  });
  renderPendingFiles();
}

async function uploadChatAttachment(file, sessionId) {
  const res = await eduFetch(`/api/attachments?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.attachment;
}

/* ---------- 对话内练习卡片（题组：逐题作答 + 每题可问） ---------- */
/** 渲染交给 public/practice-card.js；这里只做依赖注入与状态桥接
 *  题组由后端 buildPracticePayload 生成：讲解后趁热打铁 / 用户要求多练时按薄弱点出题 */
function addPracticeCard(data) {
  if (!window.EduPracticeCard) return;
  const sessionId = SESSION_ID;
  window.EduPracticeCard.render(data, {
    sessionId,
    onGraded: async () => { await refreshSidebarProgress(sessionId); await refreshMistakeBadge(sessionId); },
    escapeHtml,
    brandAvatar: BRAND_AVATAR,
    container: $('messages'),
    scrollToBottom: function () { $('messages').scrollTop = $('messages').scrollHeight; },
    canInteract: function () { return !sending && !switchingLock; },
    sendMessage,
    askExplain: cardAskExplain,
    recordAnswer: function (kpId, payload, feedback) { return recordCardAnswer(sessionId, payload, feedback); },
  });
}

/** "让 EduPilot 讲讲 / 问一下"：把题目与作答作为上下文发给智能体，点评流式显示在对话流 */
async function cardAskExplain(ctx) {
  if (!ctx) return;
  let msg;
  if (ctx.question) {
    // 把"对错"和"标准答案"写进消息：只描述作答内容时，模型常把答错的题说成"答对了"。
    const q = ctx.question;
    const state = ctx.correct === true ? ui("答对了") : ctx.correct === false ? ui("答错了") : ui("已作答");
    msg = `${ui("请讲讲刚才这道题：")}${q.q || ''}\n`
      + `${ui("（我选了 ")}${ctx.userAnswer || '?'}${ctx.userAnswerText ? ' ' + ctx.userAnswerText : ''}${ui("，")}${state}${ui("；")}`
      + `${ui("标准答案是 ")}${q.answer || '?'}${ui("）")}`;
  } else {
    msg = ui("这道题我卡住了，先给我一点提示吧（不要直接给完整答案）") + (ctx.problemTitle ? ui("：") + ctx.problemTitle : '');
  }
  return sendMessage(msg, {
    mode: 'card', ...ctx,
    problemTitle: ctx.problemTitle || ctx.kpTitle || ui("练习卡片"),
  });
}

async function recordCardAnswer(sessionId, payload, feedback) {
  try {
    const r = await api('/api/coding/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...payload }),
    });
    await refreshSidebarProgress(sessionId);
    // 答错会自动进错题本：顺手刷新入口计数，用户不用切页面才能看到
    if (payload && payload.correct === false) refreshMistakeBadge(sessionId);
    return r;
  } catch (e) {
    const warning = document.createElement('p');
    warning.textContent = ui("⚠️ 本次结果未保存：") + e.message;
    feedback.appendChild(warning);
    return null;
  }
}

/* ---------- 错题本（面板：列表 / 重练 / 删除） ---------- */
let _mistakeCache = []; // 当前面板的错题（重练/删除按 id 回查，避免把题干塞进 DOM 再解析）

/** 错题自动进本：只用计数刷新入口徽标，不必把整个列表都拉下来 */
async function refreshMistakeBadge(sessionId = SESSION_ID) {
  const entry = $('mistakeEntry');
  if (!entry) return;
  try {
    const d = await api(`/api/mistakes?sessionId=${encodeURIComponent(sessionId)}`);
    if (sessionId !== SESSION_ID) return; // 已切换课程：过期响应不能覆盖
    const n = d.count || 0;
    $('mistakeCount').textContent = n ? `${n}${ui(" 题")}` : ui("0 题");
    $('mistakeSub').textContent = n ? ui("点开可重练或删除") : ui("答错的题会自动收进来");
    entry.classList.toggle('has-items', n > 0);
  } catch (_) { /* 静默：徽标不是关键路径 */ }
}

function closeMistakePanel() { $('mistakeOverlay').classList.add('hidden'); }

/** 渲染一条错题：题干 + 你的答案 + 正确答案 + 解析 + 操作 */
function mistakeRowHtml(m) {
  const opts = (m.options || []).map((o, i) => {
    const letter = String.fromCharCode(65 + i);
    return (letter === m.userAnswer ? `${ui("<span class=\"mistake-row-wrong\">你的答案：")}${letter}. ${escapeHtml(o)}</span>`
      : letter === m.answer ? `${ui("<span class=\"mistake-row-right\">正确答案：")}${letter}. ${escapeHtml(o)}</span>` : '');
  }).filter(Boolean).join('<br/>');
  return `<div class="mistake-row" data-id="${escapeHtml(m.id)}">
    <div class="mistake-row-q">❌ ${escapeHtml(m.question)}${ui("</div>\n    <div class=\"mistake-row-meta\">《")}${escapeHtml(m.courseTitle)}${ui("》 · ")}${escapeHtml(m.kpTitle)}${m.at ? ' · ' + escapeHtml(String(m.at).slice(0, 10)) : ''}</div>
    ${opts || `${ui("<div class=\"mistake-row-wrong\">你的答案：")}${escapeHtml(m.userAnswer || '')}</div>${m.answer ? `${ui("<div class=\"mistake-row-right\">正确答案：")}${escapeHtml(m.answer)}</div>` : ''}`}
    ${m.explanation ? `<div class="mistake-row-exp">💡 ${escapeHtml(m.explanation)}</div>` : ''}
    <div class="mistake-row-actions">
      ${m.replayable ? ui("<button class=\"mk-retry\">🔁 重练这题</button>") : ''}${ui("\n      <button class=\"mk-del\">🗑 删除</button>\n    </div>\n  </div>")}`;
}

async function openMistakePanel() {
  const overlay = $('mistakeOverlay');
  const list = $('mistakeList');
  overlay.classList.remove('hidden');
  list.innerHTML = ui("<div class=\"mistake-empty\">加载中…</div>");
  const sid = SESSION_ID;
  let d;
  try {
    d = await api(`/api/mistakes?sessionId=${encodeURIComponent(sid)}`);
  } catch (e) {
    list.innerHTML = `${ui("<div class=\"mistake-empty\">加载失败：")}${escapeHtml(e.message)}</div>`;
    return;
  }
  if (sid !== SESSION_ID) return; // 加载期间切了课程
  const items = d.mistakes || [];
  _mistakeCache = items; // 重练/删除按 id 回查，避免把题干塞进 DOM 属性再解析
  $('mistakePanelSub').textContent = items.length
    ? `${ui("共 ")}${items.length}${ui(" 条。点「重练这题」在对话里再答一次；答对后仍保留记录，可手动删除。")}`
    : ui("还没有错题。答错的题会自动收进这里。");
  if (!items.length) { list.innerHTML = ui("<div class=\"mistake-empty\">🎉 目前没有错题</div>"); return; }
  list.innerHTML = items.map(mistakeRowHtml).join('');
}

/** 错题面板内的点击：重练（发消息出卡片）/ 删除（确认后按 id 删） */
async function onMistakeListClick(e) {
  const row = e.target.closest('.mistake-row');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.mk-retry')) {
    const m = _mistakeCache.find((x) => x.id === id);
    if (!m) return;
    closeMistakePanel();
    // 走对话：后端据 context.mode='mistake' 重建这一道题的互动卡片（replay，不推进正式测验）
    sendMessage(`${ui("重练这道错题：")}${m.question}`, {
      mode: 'mistake', kpId: m.kpId, question: m.question,
      problemTitle: m.kpTitle || ui("错题重练"),
    });
    return;
  }
  if (e.target.closest('.mk-del')) {
    const m = _mistakeCache.find((x) => x.id === id);
    if (!m) return;
    // 内嵌浏览器会拦截原生 confirm，统一走页面内确认框
    const ans = await showConfirm(ui("从错题本删除这条记录？\n") + m.question, { title: ui("删除错题"), okText: ui("删除") });
    if (!ans.ok) return;
    try {
      await api('/api/mistakes/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, ids: [id] }),
      });
      await openMistakePanel(); // 重渲染列表
      refreshMistakeBadge(SESSION_ID);
    } catch (err) {
      await showConfirm(ui("删除失败：") + err.message, { title: ui("删除失败"), okText: ui("知道了") });
    }
  }
}

$('mistakeEntry').addEventListener('click', () => { openMistakePanel(); });
$('mistakeCloseBtn').addEventListener('click', closeMistakePanel);
$('mistakeOverlay').addEventListener('click', (e) => { if (e.target === $('mistakeOverlay')) closeMistakePanel(); });
$('mistakeList').addEventListener('click', onMistakeListClick);
$('mistakeClearBtn').addEventListener('click', async () => {
  if (!_mistakeCache.length) return;
  const ans = await showConfirm(`${ui("清空错题本（当前 ")}${_mistakeCache.length}${ui(" 条）？此操作不可恢复。\n（只删错题记录，不影响已通过的检测与掌握状态）")}`, { title: ui("清空错题本"), okText: ui("清空") });
  if (!ans.ok) return;
  try {
    await api('/api/mistakes/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, ids: _mistakeCache.map((m) => m.id) }),
    });
    await openMistakePanel();
    refreshMistakeBadge(SESSION_ID);
  } catch (err) {
    await showConfirm(ui("清空失败：") + err.message, { title: ui("清空失败"), okText: ui("知道了") });
  }
});

/* 运行诊断只发送给独立调试页，不在学习页面渲染。 */
const diagnostics = typeof BroadcastChannel === 'function' ? new BroadcastChannel('eduowl-debug') : null;
function reportDiagnostic(sessionId, status, tool = null) {
  diagnostics?.postMessage({ sessionId, status, tool, at: new Date().toISOString() });
}

function phaseClass(phase) { return 'phase-' + phase; }
function phaseLabel(phase) {
  return { not_started: window.t('notStarted'), preview: window.t('phasePreview'), learning: window.t('phaseLearning'), reviewing: window.t('phaseReviewing'), mastered: window.t('phaseMastered') }[phase] || phase;
}
function renderSidebar() {
  if (!courseData) return;
  $('courseTitle').textContent = window.tc(courseData.title);
  // 同步课程选择器显示当前课程
  const sel = $('courseSelect');
  if (sel && sel.value !== (courseData.id || '')) sel.value = courseData.id || '';

  const list = $('chapterList');
  list.innerHTML = '';

  // 进度环：内置课与动态课都展示（动态课 = 节级学习状态：检索讲解只记录学习覆盖）
  $('overallBox').classList.remove('hidden');
  $('sideFoot').innerHTML = isDynamicCourse
    ? '<p>' + window.t('sideFootDynamic') + '</p>'
    : '<p>' + window.t('sideFootBuiltin') + '</p>';

  (courseData.chapters || []).forEach((ch, i) => {
    const sec = document.createElement('div');
    sec.className = 'chapter';
    const kps = ch.knowledgePoints || [];
    const titleEl = document.createElement('div');
    titleEl.className = 'chapter-title';
    // 章节级聚合提示：本章有几个知识点到了复习时间
    const chapterDue = kps.filter((kp) => {
      const rec = learning && learning.kps && learning.kps[kp.id];
      return rec && EduProgress.reviewStatus(rec) === 'due';
    }).length;
    titleEl.innerHTML = `${escapeHtml(window.tc(ch.title || `${ui("章节 ")}${i + 1}`))}${chapterDue ? `${ui("<span class=\"chapter-due\">🔁 待复习 ")}${chapterDue}</span>` : ''}`;
    sec.appendChild(titleEl);

    if (kps.length) {
      kps.forEach((kp) => {
        const rec = (learning && learning.kps && learning.kps[kp.id]) || { phase: 'not_started' };
        // 下一步动作由"所处阶段 + 还缺哪一步检测"共同决定；跳步时自然转成"先补这一步"
        let actionLabel;
        let actionMsg;
        const due = EduProgress.reviewStatus(rec) === 'due';
        if (isDynamicCourse && !courseData.learningReady) {
          const label = `${window.tc(ch.title)} · ${window.tc(kp.title)}`;
          actionLabel = rec.phase === 'mastered' ? window.t('actionRevisit') : rec.phase === 'learning' ? window.t('actionDiveDeeper') : window.t('actionExplore');
          actionMsg = `${ui("讲讲「")}${label}${ui("」的内容")}`;
        } else {
          const a = kpAction(rec, kp.title);
          actionLabel = a.label;
          actionMsg = a.msg;
        }
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'kp-item';
        item.dataset.kpId = kp.id;
        item.dataset.title = kp.title;
        item.title = actionLabel;
        item.innerHTML = `
          <span class="kp-phase ${phaseClass(rec.phase)}">${phaseLabel(rec.phase)}</span>
          <span class="kp-name">${escapeHtml(kp.title)}${due ? ui("<span class=\"kp-due\">该复习了</span>") : ''}</span>
          <span class="kp-action">${actionLabel}</span>`;
        item.addEventListener('click', () => sendMessage(actionMsg));
        sec.appendChild(item);
      });
    } else if (isDynamicCourse) {
      // 兜底：旧素材章无小节 → 整章一个提问入口（不参与节级进度）
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'kp-item';
      item.dataset.kpId = `ch${i}`;
      item.innerHTML = '<span class="kp-name">' + window.t('askChapter') + '</span><span class="kp-action">' + window.t('actionExplore') + '</span>';
      item.addEventListener('click', () => sendMessage(`${ui("讲讲「")}${ch.title || ui('章节 ') + (i + 1)}${ui('」的内容')}`));
      sec.appendChild(item);
    }
    list.appendChild(sec);
  });
  if (!courseData.chapters || !courseData.chapters.length) {
    list.innerHTML = '<p style="color:var(--text-2);font-size:13px;padding:8px;">' + window.t('noChapters') + '</p>';
  }
  renderOverall();
  updatePracticeLinks();
  if (learning && learning.currentKpId) highlightKp(learning.currentKpId);
  updateBusyUI();
}

/** 素材课的测验在对话区进行；编程工作区仅服务内置 Python 课程。 */
function updatePracticeLinks() {
  const apply = (id, page, origTitle) => {
    const a = $(id);
    if (!a) return;
    if (!courseData) return;
    a.onclick = null;
    if (isDynamicCourse && id === 'choiceLink' && courseData.learningReady) {
      a.classList.remove('disabled-entry');
      a.removeAttribute('aria-disabled');
      a.setAttribute('href', '/?course=' + encodeURIComponent(courseData.id));
      a.setAttribute('title', ui('在对话中进行三阶段测验'));
      a.onclick = event => { event.preventDefault(); sendMessage(ui('做题')); };
    } else if (isDynamicCourse) {
      a.classList.add('disabled-entry');
      a.setAttribute('aria-disabled', 'true');
      a.removeAttribute('href');
      a.setAttribute('title', window.t('noPracticeForDynamic'));
    } else {
      a.classList.remove('disabled-entry');
      a.removeAttribute('aria-disabled');
      a.setAttribute('href', page + '?course=' + encodeURIComponent(courseData.id));
      a.setAttribute('title', origTitle);
    }
  };
  apply('codingLink', '/coding.html', window.t('codingTitle'));
  apply('choiceLink', '/choice.html', window.t('quizTitle'));
}
/* ============ 学习旅程：预习/学习/复习 是"教师角色"，不是可量化的刻度 ============ */
/** 阶段 → 老师此刻在做什么（与后端 state.js STAGE_TEACHING 一致） */
const STAGE_TEACHING = {
  preview: { emoji: '🔎', label: window.t('stagePreviewLabel'), teacher: window.t('stagePreviewTeacher') },
  learning: { emoji: '📖', label: window.t('stageLearningLabel'), teacher: window.t('stageLearningTeacher') },
  reviewing: { emoji: '🔁', label: window.t('stageReviewingLabel'), teacher: window.t('stageReviewingTeacher') },
  mastered: { emoji: '🎉', label: window.t('stageMasteredLabel'), teacher: window.t('stageMasteredTeacher') },
  not_started: { emoji: '🗺️', label: window.t('stageNotStartedLabel'), teacher: window.t('stageNotStartedTeacher') },
};
/** 知识点行右侧的"下一步动作"：由「所处阶段 + 还缺哪一步检测」共同决定
 *  严格梯级下，跳步的请求会被老师转成"先补这一步"，所以按钮文案也如实反映 */
function kpAction(rec, title) {
  const phase = (rec && rec.phase) || 'not_started';
  if (phase === 'not_started') return { label: window.t('actionStartPreview'), msg: `${window.t('actionPreviewMsg')} ${title}` };
  if (phase === 'mastered') return { label: window.t('actionReviewAgain'), msg: `${window.t('actionReviewMsg')} ${title}` };
  if (phase === 'preview' && rec.checks?.preview) return { label: ui('学习讲解'), msg: `${ui('学习 ')}${title}` };
  const gate = EduProgress.nextGate(rec);
  if (gate && gate.need === 'preview') return { label: window.t('actionPreviewQuiz'), msg: `${window.t('actionQuizMsg')} ${title}` };
  if (gate && gate.need === 'learn') return { label: window.t('actionClassQuiz'), msg: `${window.t('actionQuizMsg')} ${title}` };
  if (gate && gate.need === 'review') return { label: window.t('actionReviewQuiz'), msg: `${window.t('actionReviewTestMsg')} ${title}` };
  return { label: window.t('actionContinueReview'), msg: `${window.t('actionReviewMsg')} ${title}` };
}

/** 本地汇总旅程状态（结构与后端 overallProgress 一致，供首次渲染用） */
function localProgress() {
  return EduProgress.overallProgress(learning, courseData || { chapters: [] });
}

function renderOverall() {
  if (!learning) return;
  renderOverallStats(localProgress());
}

/** 渲染"学习旅程"：高亮学生此刻所处的阶段，并用老师口吻说明这一步要做什么（无数值进度） */
function renderOverallStats(p) {
  if (!p) return;
  const total = p.total || 0;
  const cur = p.current || null;
  const phase = (cur && cur.phase) || p.activePhase || 'not_started';
  const t = STAGE_TEACHING[phase] || STAGE_TEACHING.not_started;
  const steps = document.querySelectorAll('#journeySteps .jstep');
  steps.forEach((el) => {
    el.classList.remove('active', 'done');
    if (!cur && p.activePhase === 'mastered') el.classList.add('done');
    else if (el.dataset.phase === phase) el.classList.add('active');
  });
  if (!total) {
    $('overallText').textContent = window.t('overallStart');
    $('overallSub').textContent = window.t('overallStartSub');
  } else if (p.mastered === total && (!cur || cur.phase === 'mastered')) {
    $('overallText').textContent = window.t('overallAllDone');
    $('overallSub').textContent = window.t('overallAllDoneSub');
  } else if (!cur) {
    // 有知识点但拿不到"当前点"（会话学习记录与课程大纲尚未对齐）：
    // 不能直接访问 cur.phase（曾因此抛错导致侧栏整块渲染中断），给中性文案兜底
    $('overallText').textContent = window.t('overallUpdated');
    $('overallSub').textContent = window.t('overallUpdatedSub');
  } else if (cur.phase === 'not_started') {
    $('overallText').textContent = window.t('overallNotStarted') + cur.title;
    $('overallSub').textContent = STAGE_TEACHING.not_started.teacher;
  } else {
    $('overallText').textContent = t.label + ': ' + cur.title;
    $('overallSub').textContent = t.teacher;
  }
  $('overallCounts').textContent = `${window.t('overallStudied')} ${p.studied || 0}/${total} · ${window.t('overallMastered')} ${p.mastered || 0}/${total}`;
  refreshDueBar();
  refreshQuizResumeBar();
  refreshExamEntry();
}

/** 期末大实践入口状态（与后端 unlockStatus 同口径：全部知识点通过随堂练习检测） */
function refreshExamEntry() {
  const stateEl = $('examState');
  if (!stateEl) return;
  const kps = (learning && learning.kps) || {};
  const ids = Object.keys(kps);
  const ready = ids.filter((id) => {
    const r = kps[id] || {};
    return (r.checks && r.checks.learn) || r.legacyProgress || r.phase === 'reviewing' || r.phase === 'mastered';
  }).length;
  const unlocked = ids.length > 0 && ready === ids.length;
  stateEl.textContent = unlocked ? ui("可参加") : `${ready}/${ids.length}${ui(" 就绪")}`;
  stateEl.classList.toggle('ready', unlocked);
  const sub = $('examSub');
  if (sub) {
    sub.textContent = unlocked
      ? ui("混合卷 · 闭卷 60 分钟 · 可重考")
      : `${ui("还差 ")}${ids.length - ready}${ui(" 个知识点通过随堂练习")}`;
  }
}

/* ============ 艾宾浩斯：到期复习徽标 ============ */
/** 计算当前课程到期待复习的 kp：按 review.dueAt 到期判定，与教学阶段独立 */
function dueKps() {
  return EduProgress.dueForReview(learning).map(d => ({ id: d.kpId, title: kpTitleOf(d.kpId), dueAt: d.dueAt }));
}

/** kp id → 标题（从大纲 courseData 中查；查不到用 id） */
function kpTitleOf(id) {
  for (const ch of (courseData && courseData.chapters) || []) {
    for (const kp of ch.knowledgePoints || []) {
      if (kp.id === id) return kp.title;
    }
  }
  return id;
}

/** 刷新侧栏待复习条（到期项 >0 显示；否则隐藏） */
function refreshDueBar() {
  const bar = $('dueBar');
  if (!bar) return;
  const due = dueKps();
  if (!due.length) {
    bar.classList.add('hidden');
    return;
  }
  $('dueText').textContent = `${ui("到复习时间：")}${due.map((d) => d.title).slice(0, 2).join(ui("、"))}${due.length > 2 ? `${ui(" 等 ")}${due.length}${ui(" 项")}` : ''}`;
  bar.classList.remove('hidden');
  bar.title = due.map((d) => d.title).join(ui("，"));
}

/** 复习到期第一项（内置课 → "复习 XX"；动态课 → 再次提问该节） */
function startDueReview() {
  const due = dueKps();
  if (!due.length) return;
  const target = due[0];
  sendMessage(isDynamicCourse && !courseData.learningReady ? `${ui("再讲讲「")}${window.tc(target.title)}${ui("」的内容吧")}` : `${ui("复习 ")}${window.tc(target.title)}`);
}

/** 未完成测验提示（测验按知识点独立保存，切走再回来能接着答） */
function refreshQuizResumeBar() {
  const bar = $('quizResumeBar');
  if (!bar) return;
  const pending = EduProgress.pendingQuizzes(learning);
  window._pendingQuizzes = pending;
  if (!pending.length) {
    bar.classList.add('hidden');
    return;
  }
  const first = pending[0];
  const modeCn = { preview: ui("预习自测"), learn: ui("随堂练习"), review: ui("复习测验") }[first.mode] || ui("测验");
  $('quizResumeText').textContent = `${ui("未完成：")}${first.title || kpTitleOf(first.kpId)}${ui("（")}${modeCn} ${first.answered}/${first.total}${ui("）")}${pending.length > 1 ? `${ui(" 等 ")}${pending.length}${ui(" 项")}` : ''}`;
  bar.title = pending.map((q) => `${q.title || q.kpId}${ui("：")}${q.answered}/${q.total}`).join(ui("，"));
  bar.classList.remove('hidden');
}

/** 继续未完成的测验（把该知识点重新设为当前，交给老师展示下一题） */
function resumeQuiz() {
  const pending = window._pendingQuizzes || [];
  if (!pending.length) return;
  const q = pending[0];
  const title = q.title || kpTitleOf(q.kpId);
  sendMessage(q.mode === 'review' ? `${ui("复习测试 ")}${title}` : `${ui("做题 ")}${title}`);
}

/** 到期主动提醒（仅新进入会话无历史时出现，避免打扰翻历史） */
function maybeRemindDue() {
  const due = dueKps();
  if (!due.length || !myProfile || !myProfile.nickname) return;
  addMessage('bot',
    `🔁 ${myProfile.nickname}${ui("，你有 **")}${due.length}${ui(" 个知识点**到了复习时间（")}${due.slice(0, 3).map((d) => d.title).join(ui("、"))}${due.length > 3 ? '…' : ''}${ui("）。\n\n")}` +
    `${ui("点左侧「开始复习」或直接说「**复习 XX**」，我会带你回顾并重新安排复习节奏～")}`);
}
function highlightKp(kpId) {
  document.querySelectorAll('.kp-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.kpId === kpId);
  });
  if (kpId && learning && learning.kps[kpId]) {
    const kp = findKp(kpId);
    $('nowLabel').textContent = `${ui("正在学习：")}${window.tc(kp.title)}${ui("（")}${phaseLabel(learning.kps[kpId].phase)}${ui("）")}`;
  }
}
function findKp(kpId) {
  for (const ch of courseData.chapters) {
    const kp = ch.knowledgePoints.find((k) => k.id === kpId);
    if (kp) return kp;
  }
  return null;
}

/* ---------- 发送消息（SSE 流式） ---------- */
let sending = false;

function updateBusyUI() {
  const busy = sending || switchingLock;
  $('sendBtn').disabled = busy || !courseData;
  $('sendLabel').textContent = sending ? ui("回复中…") : ui("发送");
  $('sendBtn').title = $('sendLabel').textContent;
  $('courseSelect').disabled = busy;
  $('resetBtn').disabled = busy || !courseData;
  $('renameCourseBtn').disabled = busy || !isDynamicCourse;
  $('deleteCourseBtn').disabled = busy || !isDynamicCourse;
  $('messages').setAttribute('aria-busy', String(sending));
  document.querySelectorAll('.kp-item, #quickActions .chip, .card-explain').forEach((b) => { b.disabled = busy || !courseData; });
}

function resizeInput() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 144) + 'px';
}

const sidebarMedia = window.matchMedia('(max-width: 860px)');
let sidebarMode = sidebarMedia.matches ? 'mobile' : 'desktop';
function sidebarPreferenceKey() {
  return sidebarMedia.matches ? 'eduowl_sidebar_mobile' : 'eduowl_sidebar_desktop';
}
function setSidebar(open, persist = true, moveFocus = false) {
  const toggle = $('sidebarToggle');
  const sidebar = $('courseSidebar');
  const wasDrawerOpen = sidebarMedia.matches && document.body.classList.contains('sidebar-open');
  if (!open && (sidebar.contains(document.activeElement) || wasDrawerOpen)) toggle.focus();
  document.body.classList.toggle('sidebar-open', open);
  document.body.classList.toggle('sidebar-collapsed', !open);
  document.body.dataset.sidebarState = open ? 'open' : 'closed';
  document.body.dataset.sidebarMode = sidebarMedia.matches ? 'mobile' : 'desktop';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', ui(open ? '收起侧边栏' : '展开侧边栏'));
  toggle.title = toggle.getAttribute('aria-label');
  toggle.setAttribute('data-ui-aria-label', open ? '收起侧边栏' : '展开侧边栏');
  toggle.setAttribute('data-ui-title', open ? '收起侧边栏' : '展开侧边栏');
  sidebar.setAttribute('aria-hidden', String(!open));
  sidebar.inert = !open;
  const drawerOpen = open && sidebarMedia.matches;
  $('sidebarBackdrop').hidden = !drawerOpen;
  document.querySelector('.chat-panel').inert = drawerOpen;
  document.querySelector('.top-right').inert = drawerOpen;
  if (persist) localStorage.setItem(sidebarPreferenceKey(), open ? 'open' : 'closed');
  if (moveFocus && drawerOpen) {
    const first = sidebar.querySelector('button:not(:disabled), select, a[href], input:not(:disabled), textarea:not(:disabled)');
    if (first) requestAnimationFrame(() => first.focus());
  }
}
function restoreSidebar() {
  if (window.EduOnboarding.isActive()) return;
  const saved = localStorage.getItem(sidebarPreferenceKey());
  setSidebar(saved ? saved === 'open' : !sidebarMedia.matches, false);
}
function closeSidebar() {
  if (sidebarMedia.matches) setSidebar(false);
}
/** 解析 SSE 事件块：event: xxx / data: {json} */
function parseSSEBlock(block) {
  let type = 'message';
  let dataStr = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
  }
  let data = {};
  try { data = dataStr ? JSON.parse(dataStr) : {}; } catch (_) {}
  return { type, data };
}

/** 短暂提示（用 #sendStatus 显示，几秒后恢复默认文案） */
let _flashTimer = null;
function flashStatus(msg, ms = 2600) {
  const el = $('sendStatus');
  if (!el) return;
  el.textContent = msg;
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => {
    if (el.textContent === msg) el.textContent = ui("随时提问，按你的节奏学习");
  }, ms);
}

async function sendMessage(text, context) {
  text = (text || $('input').value).trim();
  if (sending || switchingLock || !courseData) return;
  // 空消息：给明确反馈，而不是"点了没反应"（原实现直接 return）
  if (!text && !pendingFiles.length) { flashStatus(ui("请先输入内容或添加附件，再点发送")); return; }
  const filesToUpload = pendingFiles.slice();
  $('input').value = '';
  resizeInput();
  sending = true;
  updateBusyUI();
  closeSidebar();
  $('sendStatus').textContent = ui("学伴正在回复，你可以先写下一条消息");
  const requestSessionId = SESSION_ID;
  let uploaded = [];
  let typingBubble;
  let msgWrap;
  let streamStarted = false;
  let fullReply = '';
  let reader;
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), 180000);
  reportDiagnostic(requestSessionId, ui("正在处理消息"));

  try {
    if (filesToUpload.length) {
      flashStatus(ui('正在上传附件…'), 120000);
      for (const file of filesToUpload) uploaded.push(await uploadChatAttachment(file, requestSessionId));
      pendingFiles = [];
      renderPendingFiles();
    }
    addMessage('user', text, { attachments: uploaded });
    typingBubble = addMessage('bot', '', { typing: true });
    msgWrap = typingBubble.closest('.msg');
    const res = await eduFetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: requestSessionId, message: text, attachments: uploaded.map((item) => ({ id: item.id })), context, webMode: webOn ? 'on' : 'off' }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);

    // 流式读取 SSE
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalData = null;
    let streamError = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop(); // 最后一段可能不完整，留到下一轮
      for (const block of blocks) {
        const ev = parseSSEBlock(block);
        if (ev.type === 'tool') {
          const out = ev.data.output || {};
          reportDiagnostic(requestSessionId, ui("工具调用：") + ev.data.name, ev.data);
        } else if (ev.type === 'delta') {
          if (!streamStarted) { streamStarted = true; reportDiagnostic(requestSessionId, ui("正在生成回答")); }
          fullReply += ev.data.text || '';
          const box = $('messages');
          const follow = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
          msgWrap.classList.remove('typing');
          typingBubble.innerHTML = renderMarkdown(fullReply);
          if (follow) box.scrollTop = box.scrollHeight;
        } else if (ev.type === 'card') {
          // 方案A：学习讲解完成后的练习卡片（选择题 + 编程挑战，不离开对话）
          addPracticeCard(ev.data);
        } else if (ev.type === 'done') {
          finalData = ev.data;
        } else if (ev.type === 'error') {
          streamError = ev.data.message || ui("服务端内部错误");
        }
      }
    }

    // 服务端明确报错
    if (streamError) throw new Error(ui("服务端：") + streamError);
    // 兜底：流没发 done 但已结束
    if (!finalData) throw new Error(ui("连接已中断，回复未完整接收，请重试"));
    fullReply = finalData.reply || fullReply;
    msgWrap.classList.remove('typing');
    typingBubble.innerHTML = renderMarkdown(fullReply || ui("（没有收到回复，请重试）"));

    // 更新进度与当前知识点（内部 Agent 状态不再展示给用户，仅更新侧栏与调试）
    if (finalData) {
      if (finalData.progress) renderOverallStats(finalData.progress);
      if (finalData.currentKp) highlightKp(finalData.currentKp.kpId);
    }
    // 重拉当前课程学习状态，确保知识点行与本轮阶段推进一致。
    await refreshSidebarProgress(requestSessionId);
    reportDiagnostic(requestSessionId, ui("回复完成"));
    $('sendStatus').textContent = ui("回复完成 · 可以继续提问");
  } catch (e) {
    if (filesToUpload.length) {
      pendingFiles = filesToUpload;
      renderPendingFiles();
    }
    const failedBubble = typingBubble || addMessage('bot', '');
    const failedWrap = failedBubble && failedBubble.closest('.msg');
    if (failedWrap) failedWrap.classList.remove('typing');
    const msg = e.name === 'AbortError'
      ? ui("⏱️ 响应超时（180 秒），服务端可能卡住了，请稍后重试")
      : ui("⚠️ 请求失败：") + e.message;
    const errorBubble = failedBubble;
    errorBubble.innerHTML = renderMarkdown(fullReply);
    const error = document.createElement('p');
    error.textContent = msg;
    errorBubble.appendChild(error);
    if (!$('input').value) { $('input').value = text; resizeInput(); }
    reportDiagnostic(requestSessionId, ui("请求失败：") + e.message);
    $('sendStatus').textContent = ui("发送未完成，消息已保留，可重试");
  } finally {
    clearTimeout(timeoutTimer);
    controller.abort();
    if (reader) reader.releaseLock();
    sending = false;
    updateBusyUI();
    $('input').focus();
  }
}


/* ---------- 课程管理：列表 / 切换 / 改名 / 删除 / 上传 ---------- */

/** 具备讲义的课程共用学习入口；旧素材课保留问答入口。 */
function renderQuickChips() {
  const box = $('quickActions');
  if (!box) return;
  box.innerHTML = '';
  const firstTitle = courseData.chapters?.[0]?.knowledgePoints?.[0]?.title || '';
  const defs = isDynamicCourse && !courseData.learningReady
    ? [
        { msg: ui("这份素材讲了什么"), label: ui("素材概览") },
        { msg: ui("总结这份素材的重点"), label: ui("划重点") },
        { msg: ui("讲讲 ") + ((courseData.chapters[0] || {}).title || ui("第一章节")), label: ui("问章节") },
      ]
    : [
        { msg: window.t('chipOutline'), label: window.t('chipOutline') },
        { msg: window.t('actionPreviewMsg') + ' ' + firstTitle, label: ui("开始预习") },
        { msg: ui('学习 ') + firstTitle, label: ui("学习讲解") },
        { msg: ui("做题"), label: ui("随堂练习") },
        { msg: ui("复习"), label: ui("复习巩固") },
        { msg: ui("我的进度"), label: ui("我的进度") },
      ];
  defs.forEach(({ msg, label }) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.msg = msg;
    b.textContent = label;
    b.addEventListener('click', () => sendMessage(msg));
    box.appendChild(b);
  });
}

/** 加载课程列表（内置 + 用户上传）填充下拉 */
async function loadCourses(keepCourseId) {
  let courses = [];
  try {
    const data = await (await eduFetch('/api/courses?lang=' + eduLanguage())).json();
    courses = data.courses || [];
  } catch (_) {}
  const sel = $('courseSelect');
  sel.innerHTML = '';
  courses.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.title;
    sel.appendChild(opt);
  });
  const want = keepCourseId || (courseData && courseData.id);
  if (want) sel.value = want;
  return courses;
}

/** 切换课程 = 切换到该课程独立的会话（uid 不变，session = uid@courseId）
 *  消息历史 / 学习进度 / 记忆均按课程隔离 → 对话区整体刷新为新课会话 */
let switchingLock = false;
async function switchCourse(courseId) {
  if (courseId === (courseData && courseData.id)) return;
  if (switchingLock || sending) return;
  switchingLock = true;
  updateBusyUI();
  try {
    setCurrentCourse(courseId);
    SESSION_ID = sessionIdFor(courseId);
    setWebOn(localStorage.getItem(webModeKey()) === 'on', { persist: false }); // 每门课各自记住联网开关
    $('messages').innerHTML = '';        // 对话框独立：清掉上一门课的对话
    $('sendStatus').textContent = ui("随时提问，按你的节奏学习");
    $('input').value = '';
    resizeInput();
    await loadCourseIntoUI(courseId);
  } catch (e) {
    // 此时会话/课程可能已在服务端就绪但界面加载失败（历史 bug 曾把"成功"误报为"失败"）：
    // 提示真实原因并刷新页面自愈（刷新后按 localStorage 恢复一致状态）
    alert(ui("切换课程未完成：") + (e.message || ui("未知错误")) + ui("\n（若目标课程已显示，可忽略；页面将刷新以同步状态）"));
    location.reload();
  } finally {
    switchingLock = false;
    updateBusyUI();
  }
}

/** 拉取课程大纲并应用（服务端按 session 解析课程，无需 switch API） */
async function loadCourseIntoUI(courseId) {
  const data = await api(`/api/course?sessionId=${encodeURIComponent(SESSION_ID)}${langParam()}`);
  if (!data || !data.course) throw new Error(ui("课程数据异常（服务端返回为空）"));
  courseData = data.course;
  learning = data.learning;
  isDynamicCourse = !!data.dynamic;
  if (SESSION_ID !== sessionIdFor(courseData.id)) {
    SESSION_ID = sessionIdFor(courseData.id);
    setCurrentCourse(courseData.id);
    return loadCourseIntoUI(courseData.id);
  }
  // 课程名可改名（动态课）；内置课不可
  $('renameCourseBtn').disabled = !isDynamicCourse;
  $('deleteCourseBtn').disabled = !isDynamicCourse;
  $('deleteCourseBtn').title = isDynamicCourse ? ui("删除这门课（不可恢复）") : ui("内置课程不可删除");
  renderSidebar();
  renderQuickChips();
  refreshMistakeBadge(SESSION_ID); // 错题本入口计数（切课/进入课程时同步）
  $('nowLabel').textContent = data.dynamic && !courseData.learningReady
    ? `${ui("正在学习：")}${courseData.title}${ui("（素材问答 · ")}${progressText() || ui("尚未开始")}${ui("）")}`
    : `${ui("正在学习：")}${courseData.title}`;
  // 会话历史（独立对话框）：新课先欢迎，回来过的课回显历史
  const hist = await loadSessionHistory();
  if (hist) { $('input').focus(); return; }
  if (isDynamicCourse && courseData.learningReady) {
    addMessage('bot', `${ui('📖 课程《')}${courseData.title}${ui('》的教学讲义和题目已准备好。\n\n点击左侧章节，从预习开始，依次完成学习和复习测验；也可以随时提问教材内容。')}`);
  } else if (isDynamicCourse) {
    addMessage('bot',
      `${ui("👋 你好")}${greetName()}${ui("！我是 **EduPilot**（AI 学习向导）。\n\n")}` +
      `${ui("当前课程是《**")}${courseData.title}${ui("**》（你上传的素材，自由问答模式）。\n\n")}` +
      `${ui("- 想传更多素材或建新课？点上方 **＋ 上传** 进入上传页；\n")}` +
      `${ui("- 直接问我素材里的内容，我会检索这份教材回答，并标注来源；\n")}` +
      `${ui("- 点击课程目录中的小节深入学习，学习旅程会记录你当前的位置。\n\n")}` +
      `${ui("试试问：「")}${(courseData.chapters[0] || {}).title || ui("这份素材讲了什么")}${ui("」")}`);
  } else {
    addMessage('bot',
      `${ui("👋 你好")}${greetName()}${ui("！我是 **EduPilot**（AI 学习向导），你的专属学习智能体。\n\n")}` +
      `${ui("我会带你走完 **预习 → 学习 → 复习** 的完整流程。现在开始学习《")}${window.tc(courseData.title)}${ui("》吧！\n\n")}` +
      `${ui("试试点击左侧知识点，或直接输入「**学习 函数**」～")}`);
  }
  setTimeout(maybeRemindDue, 600); // 到期复习提醒（无历史新进入时）
  $('input').focus();
}

/** 学习覆盖与测验证据分别展示，口径与报告一致。 */
function progressText() {
  if (!learning || !learning.kps) return '';
  const p = localProgress();
  return p.total ? `${ui("已学习 ")}${p.studied}/${p.total}${ui(" · 已验证掌握 ")}${p.mastered}/${p.total}` : '';
}

/** 重拉当前课程的最新状态；过期响应不能覆盖已经切换的课程。 */
async function refreshSidebarProgress(sessionId = SESSION_ID) {
  try {
    const data = await api(`/api/course?sessionId=${encodeURIComponent(sessionId)}${langParam()}`, { signal: AbortSignal.timeout(10000) });
    if (sessionId !== SESSION_ID) return;
    if (data && data.course) {
      learning = data.learning;
      courseData = data.course;
      isDynamicCourse = !!data.dynamic;
      renderSidebar();
    }
  } catch (_) { /* 静默失败：下次进入课程或下轮对话会再同步 */ }
}

/** 回显本课程会话的历史消息（若存在）；返回 true 表示有历史 */
async function loadSessionHistory() {
  try {
    const res = await eduFetch(`/api/session/${encodeURIComponent(SESSION_ID)}`);
    if (!res.ok) return false;
    const info = await res.json();
    const msgs = (info.messages || []).filter((m) => m && m.content);
    if (!msgs.length) return false;
    msgs.slice(-12).forEach((m) => addMessage(m.role === 'user' ? 'user' : 'bot', m.content, { attachments: m.attachments || [] }));
    addMessage('bot', `${ui("— 已回到《")}${window.tc(courseData.title)}${ui("》的对话历史（最近 ")}${Math.min(msgs.length, 12)}${ui(" 条）—")}`);
    return true;
  } catch (_) { return false; }
}

/** 改名（动态课） */
async function renameCourse() {
  if (sending || switchingLock) return;
  // 用页面内输入框替代原生 prompt（内嵌浏览器会拦截原生弹窗）
  const ans = await showConfirm(ui("输入新的课程名称（1~60 字）："), { title: ui("课程改名"), okText: ui("保存"), input: true, inputValue: (courseData && courseData.title) || '' });
  const title = ans.value;
  if (!title || !title.trim()) return;
  try {
    const data = await api('/api/course/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: courseData.id, title: title.trim() }),
    });
    if (!data.ok) throw new Error(data.error || ui("改名失败"));
    courseData.title = data.title;
    $('courseTitle').textContent = window.tc(courseData.title);
    await loadCourses(courseData.id);
    $('nowLabel').textContent = `${ui("正在学习：")}${courseData.title}` + (!courseData.learningReady ? `${ui("（素材问答 · ")}${progressText() || window.t('learned') + ' 0/X'}${ui("）")}` : '');
  } catch (e) {
    alert(ui("改名失败：") + (e.message || ui("未知错误")));
  }
}

/** 删除动态课程（不可恢复；绑定会话自动回退内置课） */
async function deleteCourse() {
  if (!isDynamicCourse || !courseData || sending || switchingLock) return;
  const delAns = await showConfirm(`${ui("确定删除课程《")}${window.tc(courseData.title)}${ui("》？\n其知识库与对话将被移除，且不可恢复。")}`, { title: ui("删除课程"), okText: ui("删除") });
  if (!delAns.ok) return;
  let deleted = false;
  try {
    const data = await api('/api/course/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: courseData.id }),
    });
    if (!data.ok) throw new Error(data.error || ui("删除失败"));
    deleted = true;
    await switchCourse('python-intro'); // 回内置课（失败也有 switchCourse 内部自愈提示）
  } catch (e) {
    // 删除已成功但回跳内置课失败 → 不再误报"删除失败"，提示后刷新自愈
    if (deleted) {
      alert(ui("课程已删除。返回内置课程的页面刷新失败：") + (e.message || ui("未知错误")) + ui("\n即将刷新页面…"));
      location.reload();
    } else {
      alert(ui("删除失败：") + (e.message || ui("未知错误")));
    }
  }
}

/* ---------- 大模型配置向导（首次进入 + 顶部按钮随时重开） ---------- */
let _llmProviders = [];
let _llmConfig = {};
let llmReturnToSettings = false;

/** 渲染顶部"模型"徽标：真实模式显示模型名，未配置则高亮提示 */
function renderLlmChip(runtime) {
  const chip = $('llmChip');
  if (!chip) return;
  const txt = $('llmSettingsSummary');
  const provider = _llmProviders.find((p) => p.id === _llmConfig.provider);
  if (runtime && runtime.mode === 'api') {
    chip.classList.remove('not-set');
    txt.textContent = [provider ? ui(provider.name) : _llmConfig.provider, runtime.model || ui("已接入")].filter(Boolean).join(' · ');
    chip.title = `${ui("已接入真实模型：")}${runtime.model || ''}${ui("（点击可修改配置）")}`;
  } else {
    const need = !!(runtime && runtime.needsSetup);
    chip.classList.toggle('not-set', need);
    txt.textContent = need ? ui("未接入") : ui("演示模式");
    chip.title = need ? ui("尚未配置大模型 —— 点击接入真实模型") : ui("当前为离线演示模式（点击可接入真实模型）");
  }
}

async function loadLlmConfig() {
  try {
    if (!_llmProviders.length) _llmProviders = (await api('/api/llm/providers')).providers || [];
    const data = await api('/api/llm/config');
    _llmConfig = data.config || {};
    renderLlmChip(data.runtime);
  } catch (error) {
    $('llmSettingsSummary').textContent = ui('加载配置失败：') + error.message;
  }
}
window.loadLlmConfig = loadLlmConfig;

function closeLlmCard() {
  $('llmOverlay').classList.add('hidden');
  if (!$('welcomeOverlay').classList.contains('hidden')) return; // 资料卡还开着，别解 inert
  document.querySelector('.app').inert = false;
  if (llmReturnToSettings) {
    $('settingsOverlay').classList.remove('hidden');
    llmReturnToSettings = false;
  }
  window.EduOnboarding.resume();
}

function llmStatus(kind, msg) {
  const el = $('llmStatus');
  el.className = 'llm-status' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  el.classList.remove('hidden');
}

let _llmModelOptions = [];
let _llmModelRequest = 0;

function selectedLlmModel() {
  return ($('llmModel').value === '__custom__' ? $('llmCustomModel').value : $('llmModel').value).trim();
}

function updateModelSelection() {
  $('llmCustomFields').classList.toggle('hidden', $('llmModel').value !== '__custom__');
  renderVisionHint(_llmModelOptions.find(entry => entry.model === selectedLlmModel())?.capability);
  $('llmStatus').classList.add('hidden');
}

function modelModalityLabel(cap = {}) {
  if (cap.confidence !== 'official') return ui('能力未确认');
  const names = { text: '文字', image: '图片', audio: '音频', video: '视频' };
  return ui(cap.modality === 'multimodal' ? '多模态' : '单模态')
    + ' · ' + (cap.inputModalities || []).map(input => ui(names[input])).join(' / ');
}

function renderVisionHint(capability) {
  const el = $('llmVisionHint');
  if (!el) return;
  const cap = capability || { vision: null };
  el.className = 'llm-note' + (cap.vision === true ? ' ok' : '');
  $('llmVisionTestBtn').disabled = !selectedLlmModel() || cap.vision === false;
  if (cap.confidence === 'official') {
    el.textContent = ui('官网确认：') + modelModalityLabel(cap)
      + (cap.vision === false ? ui('。不支持图片输入。') : '');
    if (cap.sourceUrl) {
      const source = document.createElement('a');
      source.href = cap.sourceUrl;
      source.target = '_blank';
      source.rel = 'noopener';
      source.textContent = ui('官方能力说明');
      el.append(document.createElement('br'), source, ` · ${ui('核对日期：')}${cap.checkedAt}`);
    }
  } else {
    el.textContent = !selectedLlmModel() ? ui('请选择或填写模型名称')
      : cap.confidence === 'tested' ? ui('图片请求已通过；官方输入能力仍未确认。')
      : ui('官方输入能力未确认，可测试图片请求是否被服务接受。');
  }
}

function renderModelOptions(entries, selected = '', savedCapability) {
  _llmModelOptions = [...new Map(entries.map(entry => [entry.model, entry])).values()];
  const custom = selected && !_llmModelOptions.some(entry => entry.model === selected);
  const select = $('llmModel');
  select.innerHTML = `<option value="">${escapeHtml(ui('请选择模型'))}</option>`
    + _llmModelOptions.map(entry => `<option value="${escapeHtml(entry.model)}">${escapeHtml(entry.model)} — ${escapeHtml(modelModalityLabel(entry.capability))}</option>`).join('')
    + `<option value="__custom__">${escapeHtml(ui('自定义模型名称'))}</option>`;
  select.value = custom ? '__custom__' : selected;
  $('llmCustomModel').value = custom ? selected : '';
  if (custom) _llmModelOptions.push({ model: selected, capability: savedCapability || {} });
  updateModelSelection();
}

/** 打开配置向导：拉平台列表 + 回填当前配置 */
async function openLlmCard() {
  const overlay = $('llmOverlay');
  overlay.classList.remove('hidden');
  document.querySelector('.app').inert = true;
  $('llmStatus').classList.add('hidden');
  try {
    if (!_llmProviders.length) {
      const d = await api('/api/llm/providers');
      _llmProviders = d.providers || [];
    }
    const sel = $('llmProvider');
    sel.innerHTML = _llmProviders.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    const cfg = (await api('/api/llm/config')).config || {};
    _llmConfig = cfg;
    const cur = cfg.provider || 'deepseek';
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    renderProviderPreset(true);
    $('llmBaseUrl').value = cfg.baseUrl || $('llmBaseUrl').value;
    const preset = _llmProviders.find(p => p.id === sel.value);
    const matchesPreset = cfg.baseUrl === preset?.baseUrl || !cfg.baseUrl;
    const entries = matchesPreset ? (preset?.models || []).map(entry => entry.model === cfg.model ? { ...entry, capability: cfg.modelCapability } : entry) : [];
    renderModelOptions(entries, cfg.model || '', cfg.modelCapability);
    $('llmDisableThinking').checked = !!cfg.disableThinking;
    // 密钥只显示掩码占位：留空=不改，填写=覆盖
    $('llmApiKey').value = '';
    $('llmApiKey').type = 'password';
    $('llmKeyToggle').textContent = ui('显示');
    renderLlmKeyHint();
    $('llmSkipBtn').style.display = cfg.configured ? 'none' : '';
  } catch (e) {
    llmStatus('err', ui("加载配置失败：") + e.message);
  }
}

function renderLlmKeyHint() {
  const sameProvider = $('llmProvider').value === _llmConfig.provider
    && $('llmBaseUrl').value.trim().replace(/\/+$/, '') === (_llmConfig.baseUrl || '').replace(/\/+$/, '');
  const canReuse = sameProvider && _llmConfig.hasKey;
  $('llmApiKey').placeholder = canReuse
    ? `${ui('已保存 ')}${_llmConfig.keyMasked}${ui('（留空表示不修改）')}`
    : ui('粘贴平台申请的 Key（sk-...）');
  $('llmKeyHint').textContent = canReuse
    ? ui('已保存一个密钥。留空即沿用原 Key，填写则覆盖。')
    : ui('请填写所选供应商的 API Key；切换供应商或服务地址后不能沿用原密钥');
}

/** 切换平台：回填该平台预设地址与说明 */
function renderProviderPreset(resetUrl) {
  const id = $('llmProvider').value;
  const p = _llmProviders.find((x) => x.id === id);
  if (!p) return;
  $('llmProviderNote').innerHTML = (p.note ? escapeHtml(p.note) : '')
    + (p.docs ? `${ui("　<a href=\"")}${escapeHtml(p.docs)}${ui("\" target=\"_blank\" rel=\"noopener\">去申请 Key ↗</a>")}` : '');
  if (resetUrl) $('llmBaseUrl').value = p.baseUrl || '';
  _llmModelRequest += 1;
  renderModelOptions(p.models || []);
}

/** 拉取模型列表（用当前填写的 Key/地址，无需先保存） */
async function loadLlmModels(auto) {
  const provider = $('llmProvider').value;
  const baseUrl = $('llmBaseUrl').value.trim();
  const apiKey = $('llmApiKey').value.trim();
  if (!baseUrl) { if (!auto) llmStatus('err', ui("请先填写服务地址")); return; }
  const request = ++_llmModelRequest;
  llmStatus('busy', ui("正在从平台拉取模型列表…"));
  try {
    const d = await api('/api/llm/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, baseUrl, apiKey: apiKey || undefined }),
    });
    if (request !== _llmModelRequest) return;
    if (!d.models || !d.models.length) { llmStatus('err', ui('账户未返回模型，可从已核对的预设中选择，或检查权限后重试。')); return; }
    const selected = selectedLlmModel();
    renderModelOptions(d.modelCapabilities || [], selected, _llmModelOptions.find(entry => entry.model === selected)?.capability);
    llmStatus('ok', `${ui('已拉取 ')}${d.count}${ui(' 个模型，请从下拉菜单选择。')}`);
  } catch (e) {
    if (request !== _llmModelRequest) return;
    llmStatus('err', ui("拉取失败：") + e.message);
  }
}

/** 测试连接：保存前先验证 Key/地址/模型三者是否真的可用 */
async function testLlmConnection() {
  const baseUrl = $('llmBaseUrl').value.trim();
  const model = selectedLlmModel();
  const apiKey = $('llmApiKey').value.trim();
  if (!baseUrl) { llmStatus('err', ui("请先填写服务地址")); return; }
  if (!model) { llmStatus('err', ui('请先选择或填写模型名称')); return; }
  llmStatus('busy', ui("正在测试连接（可能需要几秒）…"));
  try {
    const d = await api('/api/llm/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: $('llmProvider').value, baseUrl, model, apiKey: apiKey || undefined }),
    });
    llmStatus('ok', `${ui("✅ 连接成功（")}${d.elapsedMs}${ui("ms）\n模型：")}${d.model}${d.replyPreview ? `${ui("\n回显：")}${d.replyPreview}` : ''}`);
  } catch (e) {
    llmStatus('err', '❌ ' + e.message);
  }
}

/** 用最小图片请求验证当前模型是否真正接受多模态消息。 */
async function testLlmVision() {
  const baseUrl = $('llmBaseUrl').value.trim();
  const model = selectedLlmModel();
  const apiKey = $('llmApiKey').value.trim();
  if (!baseUrl) { llmStatus('err', ui('请先填写服务地址')); return; }
  if (!model) { llmStatus('err', ui('请先选择或填写模型名称')); return; }
  const request = _llmModelRequest;
  llmStatus('busy', ui('正在测试图片能力（可能需要几秒）…'));
  try {
    const d = await api('/api/llm/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: $('llmProvider').value, baseUrl, model, apiKey: apiKey || undefined, testVision: true }),
    });
    if (request !== _llmModelRequest || selectedLlmModel() !== model) return;
    if (!d.vision || !d.vision.supported) throw new Error(ui('当前模型或服务不接受图片输入'));
    const entry = _llmModelOptions.find(entry => entry.model === model);
    if (entry) entry.capability = d.modelCapability;
    else _llmModelOptions.push({ model, capability: d.modelCapability });
    renderVisionHint(d.modelCapability);
    llmStatus('ok', `${ui('✅ 图片能力可用（')}${d.elapsedMs}${ui('ms）模型：')}${d.model || model}`);
  } catch (e) {
    if (request !== _llmModelRequest || selectedLlmModel() !== model) return;
    llmStatus('err', ui('图片请求测试失败：') + e.message);
  }
}

/** 保存并启用（后端写 .env 后热生效，无需重启） */
async function saveLlmConfig() {
  const provider = $('llmProvider').value;
  const baseUrl = $('llmBaseUrl').value.trim();
  const model = selectedLlmModel();
  const apiKey = $('llmApiKey').value.trim();
  if (!baseUrl) { llmStatus('err', ui("请先填写服务地址")); return; }
  if (!model) { llmStatus('err', ui('请先选择或填写模型名称')); return; }
  llmStatus('busy', ui("正在保存…"));
  try {
    const d = await api('/api/llm/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider, baseUrl, model,
        apiKey: apiKey || undefined,       // 留空 = 不修改已存的 Key
        disableThinking: $('llmDisableThinking').checked,
      }),
    });
    _llmConfig = d.config;
    renderLlmChip(d.runtime);
    closeLlmCard();
    addMessage('bot', `${ui("✅ 已接入真实大模型 **")}${d.config.model}${ui("**（")}${d.config.provider}${ui("）。\n\n现在可以正常对话、出题与判分了 —— 试着问我「学习 变量」吧！")}`);
  } catch (e) {
    llmStatus('err', ui("保存失败：") + e.message);
  }
}

/** 选择"先用离线演示模式" */
async function skipLlmSetup() {
  try { await api('/api/llm/skip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (_) {}
  renderLlmChip({ mode: 'mock', needsSetup: false });
  closeLlmCard();
  addMessage('bot', ui("👌 好的，先用**离线演示模式**。\n\n演示模式能完整体验对话、出题、错题本与学习进度，但讲解内容来自内置样例。想接入真实大模型时，点右上角「**未接入**」随时配置。"));
}

$('llmProvider').addEventListener('change', () => {
  renderProviderPreset(true);
  $('llmApiKey').value = '';
  $('llmApiKey').type = 'password';
  $('llmKeyToggle').textContent = ui('显示');
  $('llmStatus').classList.add('hidden');
  renderLlmKeyHint();
});
$('llmBaseUrl').addEventListener('input', () => {
  renderLlmKeyHint();
  _llmModelRequest += 1;
  const preset = _llmProviders.find(p => p.id === $('llmProvider').value);
  const base = $('llmBaseUrl').value.trim().replace(/\/+$/, '');
  const sameSaved = base === (_llmConfig.baseUrl || '').replace(/\/+$/, '') && preset?.id === _llmConfig.provider;
  renderModelOptions(base === preset?.baseUrl ? preset.models || [] : [], sameSaved ? _llmConfig.model : '', sameSaved ? _llmConfig.modelCapability : undefined);
  $('llmStatus').classList.add('hidden');
});
$('llmModel').addEventListener('change', () => {
  _llmModelRequest += 1;
  updateModelSelection();
});
$('llmCustomModel').addEventListener('input', () => {
  _llmModelRequest += 1;
  updateModelSelection();
});
$('llmChip').addEventListener('click', () => {
  llmReturnToSettings = !$('settingsOverlay').classList.contains('hidden');
  $('settingsOverlay').classList.add('hidden');
  openLlmCard();
});
$('llmCloseBtn').addEventListener('click', closeLlmCard);
$('llmOverlay').addEventListener('click', (e) => { if (e.target === $('llmOverlay')) closeLlmCard(); });
$('llmVisionTestBtn').addEventListener('click', testLlmVision);
$('llmKeyToggle').addEventListener('click', () => {
  const el = $('llmApiKey');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('llmKeyToggle').textContent = show ? ui("隐藏") : ui("显示");
});
$('webKeyToggle').addEventListener('click', () => {
  const el = $('webApiKey');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('webKeyToggle').textContent = show ? ui("隐藏") : ui("显示");
});
$('webSaveBtn').addEventListener('click', async () => {
  $('webSaveBtn').disabled = true;
  try { await saveWebConfig(); } finally { $('webSaveBtn').disabled = false; }
});
$('llmLoadModels').addEventListener('click', () => loadLlmModels(false));
$('llmTestBtn').addEventListener('click', testLlmConnection);
$('llmSaveBtn').addEventListener('click', saveLlmConfig);
$('llmSkipBtn').addEventListener('click', skipLlmSetup);

/* ---------- 初始化 ---------- */
async function init() {
  updateBusyUI();
  // 本地身份：拉取档案；首次进入（未设置昵称）→ 弹出开始页引导
  await loadProfile();
  await loadWebConfig();
  // 大模型配置：先查状态（未配置则先弹配置向导，再弹资料卡）
  let runtime = null;
  try { runtime = (await api('/api/health')).runtime; } catch (_) { /* 健康检查失败不阻断 */ }
  if (runtime) renderLlmChip(runtime);
  if (runtime && runtime.needsSetup) {
    await openLlmCard();
  } else if (!myProfile || !myProfile.nickname) openProfileCard(true);

  // 当前课程（URL ?course= 优先，其次上次记忆，默认内置）
  SESSION_ID = sessionIdFor(currentCourseId());
  await loadCourses(currentCourseId());
  try {
    await loadCourseIntoUI(currentCourseId());
  } catch (e) {
    console.error(ui("[init] 课程加载失败（不影响后续操作）:"), e);
    $('nowLabel').textContent = ui("⚠️ 课程加载失败：") + (e.message || ui("未知错误")) + ui("（可尝试刷新）");
  }
  window.EduOnboarding.start(UID);
}

/* ---------- 事件绑定 ---------- */
initWebToggle();
$('sendBtn').addEventListener('click', () => sendMessage());
$('attachmentBtn').addEventListener('click', () => $('attachmentInput').click());
$('attachmentInput').addEventListener('change', (e) => {
  chooseAttachments(e.target.files);
  e.target.value = '';
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    sendMessage();
  }
});
$('input').addEventListener('input', resizeInput);
$('sidebarToggle').addEventListener('click', () => {
  setSidebar($('sidebarToggle').getAttribute('aria-expanded') !== 'true', true, true);
});
$('sidebarBackdrop').addEventListener('click', closeSidebar);
sidebarMedia.addEventListener('change', () => {
  sidebarMode = sidebarMedia.matches ? 'mobile' : 'desktop';
  restoreSidebar();
});
window.addEventListener('resize', () => {
  const nextMode = sidebarMedia.matches ? 'mobile' : 'desktop';
  if (nextMode !== sidebarMode) {
    sidebarMode = nextMode;
    restoreSidebar();
  }
});
restoreSidebar();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (window.EduOnboarding.isActive()) return; // The tour handles Escape and restores the previous layout.
    if (!$('confirmOverlay').classList.contains('hidden')) { closeConfirm(false); return; }
    if (!$('llmOverlay').classList.contains('hidden')) { closeLlmCard(); return; }
    if (!$('mistakeOverlay').classList.contains('hidden')) { closeMistakePanel(); return; }
    if (!$('welcomeOverlay').classList.contains('hidden')) { closeProfileCard(); return; }
    if (!$('settingsOverlay').classList.contains('hidden')) { $('settingsOverlay').classList.add('hidden'); window.EduOnboarding.resume(); return; }
    closeSidebar();
  }
});
// 确认框按钮（不依赖原生 confirm）
$('confirmOkBtn').addEventListener('click', () => closeConfirm(true));
$('confirmCancelBtn').addEventListener('click', () => closeConfirm(false));
$('confirmOverlay').addEventListener('click', (e) => { if (e.target === $('confirmOverlay')) closeConfirm(false); });
// 带输入框的确认（改名）：Enter 提交、Esc 取消
$('confirmInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); closeConfirm(true); }
  else if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); }
});
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => sendMessage(chip.dataset.msg));
});

// 课程选择器：切换课程（每门课独立会话；错误提示与自愈在 switchCourse 内部处理）
$('courseSelect').addEventListener('change', (e) => {
  const courseId = e.target.value;
  if (!courseId || courseId === (courseData && courseData.id)) return;
  switchCourse(courseId);
});

// 上传素材：跳独立上传页（可多选批量）
$('addCourseBtn').addEventListener('click', () => {
  location.href = eduUrl('/upload.html' + (courseData ? '?course=' + encodeURIComponent(courseData.id) : ''));
});

// 改名 / 删除（仅动态课可用）
$('renameCourseBtn').addEventListener('click', renameCourse);
$('deleteCourseBtn').addEventListener('click', deleteCourse);

// 重置会话 = 仅删除当前课程的会话（对话/进度/记忆），回到该课全新开始
$('resetBtn').addEventListener('click', async () => {
    $('settingsOverlay').classList.add('hidden');
  if (sending || switchingLock) return;
  const resetAns = await showConfirm(ui("确定清空当前课程《") + (courseData ? courseData.title : '') + ui("》的对话与进度？仅影响本课程。"), { title: window.t('titleReset'), okText: window.t('okClear') });
  if (!resetAns.ok) return;
  switchingLock = true;
  updateBusyUI();
  try {
    const r = await eduFetch(`/api/session/${encodeURIComponent(SESSION_ID)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    alert(ui("重置失败：") + (e.message || ui("未知错误")));
    switchingLock = false;
    updateBusyUI();
    return;
  }
  $('messages').innerHTML = '';
  try {
    await loadCourseIntoUI(courseData && courseData.id);
  } catch (e) {
    console.error(ui("[reset] 重新加载失败:"), e);
    location.reload();
  } finally {
    switchingLock = false;
    updateBusyUI();
  }
});

// 用户资料：顶栏 chip 点击 → 编辑；保存 / 跳过
$('userChip').addEventListener('click', () => openProfileCard(false));
$('saveProfileBtn').addEventListener('click', saveProfile);
$('skipProfileBtn').addEventListener('click', closeProfileCard);
$('closeProfileBtn').addEventListener('click', closeProfileCard);
$('nicknameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) saveProfile(); });

// 艾宾浩斯：待复习条「开始复习」→ 提问第一个到期知识点
$('dueReviewBtn').addEventListener('click', startDueReview);
$('quizResumeBtn').addEventListener('click', resumeQuiz);
$('examBtn').addEventListener('click', () => {
  const cid = (courseData && courseData.id) || 'python-intro';
  window.open(eduUrl(`/exam.html?course=${encodeURIComponent(cid)}`), '_blank', 'noopener');
});

init();

window.renderSidebarFromData = function() {
  if (!window.courseData) return;
  $('courseTitle').textContent = window.tc(window.courseData.title);
  // Re-trigger loadCourseIntoUI but only the UI part? It's easier to just call loadCourseIntoUI() again from cache.
  // Actually, wait, re-rendering sidebar HTML without fetching is best.
  // I will just use location.reload() for a perfect switch if courseData exists, to avoid dealing with complex re-renders.
};
