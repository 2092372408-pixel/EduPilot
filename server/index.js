/**
 * index.js — 服务入口（零依赖，仅用 Node 原生 http）
 * ------------------------------------------------------------
 * 运行：node server/index.js        （默认端口 8787，可用 PORT 环境变量覆盖）
 *
 * 路由：
 *   GET  /              静态页面（public/）
 *   POST /api/chat      发送消息 { sessionId, message } → Agent 响应
 *   POST /api/chat/stream   SSE 流式：event tool/delta/done
 *   GET  /api/course    课程大纲 + 学习进度（前端初始化）
 *   GET  /api/session/:id   Agent 内部状态（调试面板）
 *   GET  /api/health    运行模式与版本信息
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const agent = require('./agent/core');
const llm = require('./agent/llm');
const llmConfig = require('./agent/llmconfig'); // LLM 接入配置（平台预设/模型发现/热写入）
const webConfig = require('./agent/webconfig'); // Tavily 联网配置（本机保存/掩码返回）
const logger = require('./store/logger');
const profileStore = require('./store/profiles'); // 用户档案（本地身份：昵称/头像）
const runner = require('./coding/runner');
const problemsModule = require('./coding/problems');
const grader = require('./coding/grader');
const { course, findKnowledgePoint } = require('./data/course');
const courseEn = require('./data/course_en');
const kbUpload = require('./kb/upload');
const courseRegistry = require('./kb/course-registry');
const kbSearch = require('./kb/search');
const exam = require('./exam');  // 期末大实践（混合卷：选择题 + 代码实践题）
const sessionStore = require('./store/sessionStore');
const attachmentStore = require('./store/attachmentStore');
const mcp = require('./mcp/bridge'); // MCP 工具来源（启动时拉起 mcp.servers.json 中的 Server）
const auth = require('./auth');
const { createDesktopLifecycle } = require('./desktop-lifecycle');

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const desktopMode = process.env.EDUPILOT_DESKTOP === '1' && auth.isLoopbackAddress(HOST);
let activeRequests = 0;
const desktop = desktopMode ? createDesktopLifecycle({ onIdle: stopDesktop }) : null;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const instanceFile = process.env.EDUPILOT_INSTANCE_FILE || (process.env.EDUOWL_DB
  ? `${process.env.EDUOWL_DB}.instance`
  : path.join(__dirname, '..', '.edupilot-instance'));
if (!fs.existsSync(instanceFile)) {
  try { fs.writeFileSync(instanceFile, crypto.randomUUID(), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}
const installationId = fs.readFileSync(instanceFile, 'utf8').trim();

// 本机开发保持免令牌；非回环监听必须显式配置令牌，避免误把学习/代码执行接口暴露出去。
if ((HOST === '0.0.0.0' || HOST === '::' || !auth.isLoopbackAddress(HOST)) && !auth.configuredToken()) {
  throw new Error('监听非本机地址时必须设置 EDUOWL_AUTH_TOKEN');
}

/**
 * 进程级异常兜底：任何未捕获异常/未处理的 Promise 拒绝都留下痕迹，
 * 避免服务"静默半死"。未捕获异常后进程状态不再可信 → 记录后退出，交由进程管理器拉起。
 */
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.stack ? reason.stack : String(reason);
  console.error('[unhandledRejection]', msg);
  try { logger.error('unhandled_rejection', msg.slice(0, 500)); } catch (_) { /* 日志不可用时不阻断 */ }
});
process.on('uncaughtException', (err) => {
  const msg = err && err.stack ? err.stack : String(err);
  console.error('[uncaughtException]', msg);
  try { logger.error('uncaught_exception', msg.slice(0, 500)); } catch (_) { /* 同上 */ }
  process.exit(1);
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 通用安全响应头（本地应用也不应让浏览器嗅探内容类型/被外站内嵌） */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
};

/**
 * 是否来自本机回环（含 IPv6 映射写法）。
 * 用于守护"能读改 API Key"的配置接口：服务可能被用户改成 0.0.0.0 暴露到局域网，
 * 此时若无此校验，同网段任何人都能读到/覆盖密钥。
 */


function translateBuiltinCourse(courseObj, url) {
  const lang = url.searchParams.get('lang');
  if (lang === 'en' && courseObj && courseObj.id === 'python-intro') {
    return courseEn.course;
  }
  return courseObj;
}

function pickCourse(url) {
  const lang = url.searchParams.get('lang');
  return lang === 'en' ? courseEn.course : course;
}

function isLoopback(req) {
  return auth.isLoopbackAddress(req.socket && req.socket.remoteAddress);
}

// Secret-management endpoints are available locally, or remotely after the
// service-level token has already authenticated the request. The latter is
// required for Docker, where the host browser appears as a bridge address.
function canManageSecrets(req) {
  return isLoopback(req) || !!auth.configuredToken();
}

function requireApiAuth(req, res) {
  const result = auth.authenticate(req);
  if (result.ok) return true;
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    ...auth.challengeHeaders(),
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify({ error: locale.translate('需要 API 认证：请提供 EDUOWL_AUTH_TOKEN') }));
  return false;
}

function sendJSON(res, code, data) {
  const body = JSON.stringify(locale.display(data));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

/**
 * 动态课程两级大纲视图：章 → 节。
 * 与学习状态机同源（kp.id = registry.learningKey），前端可按 id 命中 learning.kps 渲染进度。
 * 有小结的章 → 每小结一个 kp；章无小结 → 整章一个 kp。
 */
function buildDynamicCourseView(dyn) {
  return courseRegistry.dynamicCourseView(dyn);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > 1e6) {
        chunks.length = 0;
        reject(Object.assign(new Error('请求内容超过大小上限（1 MB）'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (bytes > 1e6) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch {
        reject(Object.assign(new Error('请求内容必须是有效的 JSON 对象'), { status: 400 }));
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('请求已中断'), { status: 400 })));
  });
}

/** 读二进制 body（文件上传用），上限 maxBytes，超限 reject */
function readRawBody(req, maxBytes = kbUpload.MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const fail = (msg, status) => {
      if (done) return;
      done = true;
      // 不立刻 destroy：先让上层把 413 响应写回，否则客户端只看到 connection reset，
      // 拿不到"文件超过上限"这条明确提示（上传大文件时体验最差的地方）。
      reject(Object.assign(new Error(msg), { status }));
    };
    req.on('data', (c) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) {
        const mb = (maxBytes / 1048576).toFixed(0);
        fail(`文件过大：超过 ${mb}MB 上限（当前 >${(total / 1048576).toFixed(1)}MB）。请压缩或拆分后重新上传`, 413);
        req.resume(); // 丢弃剩余数据，避免占住连接
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

/** 静态文件服务（防目录穿越） */
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  const relative = path.relative(PUBLIC_DIR, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    res.writeHead(403, SECURITY_HEADERS); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); res.end('Not Found'); return; }
    // 开发期禁用缓存：避免浏览器缓存旧版前端与新版 API 契约不匹配（曾导致"切换成功却报失败"）
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    });
    if (desktop && path.extname(file) === '.html') {
      data = data.toString('utf8').replace('</head>', '<script src="/desktop-session.js" defer></script>\n</head>');
    }
    res.end(data);
  });
}

const locale = require('./locale');
const server = http.createServer((req, res) => locale.runRequest(req, async () => {
  activeRequests++;
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/') && !requireApiAuth(req, res)) return;
    if (p === '/api/desktop/events' && req.method === 'GET') {
      if (!desktop) { res.writeHead(204, SECURITY_HEADERS); res.end(); return; }
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if (!isLoopback(req) || (origin && origin !== `http://${req.headers.host}`)
        || (site && site !== 'same-origin' && site !== 'none')) {
        sendJSON(res, 403, { error: 'Desktop sessions must come from this application' });
        return;
      }
      desktop.connect(res);
      return;
    }
    // API 路由
    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || 'default');
      const message = String(body.message || '').trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!message && !attachments.length) { sendJSON(res, 400, { error: '消息不能为空' }); return; }
      const result = await agent.run(sessionId, message, { webMode: body.webMode, attachments });
      sendJSON(res, 200, { sessionId, ...result });
      return;
    }

    // SSE 流式接口：event: tool（工具调用）/ delta（文本增量）/ done（完整结果）
    if (p === '/api/chat/stream' && req.method === 'POST') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || 'default');
      const message = String(body.message || '').trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!message && !attachments.length) { sendJSON(res, 400, { error: '消息不能为空' }); return; }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...SECURITY_HEADERS,
      });
      res.write('retry: 2000\n\n');

      // 连接中断检测：前端断连（network error）在此留痕——排查"请求失败"的关键
      let streamDone = false;
      const controller = new AbortController();
      const onClose = () => {
        if (!streamDone) {
          controller.abort();
          logger.warn('sse_close', `[${sessionId}] SSE 连接在完成前中断（前端断开/超时）`, { sessionId, message: message.slice(0, 60) });
        }
      };
      res.on('close', onClose);
      if (res.destroyed) onClose();
      const sendEvent = (event, data) => {
        if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const result = await agent.runStream(sessionId, message, {
          signal: controller.signal,
          onTool: (tc) => sendEvent('tool', tc),
          onDelta: (text) => sendEvent('delta', { text }),
          context: body.context, // 做题悬浮窗上下文（P3）
          webMode: body.webMode, // 首页"是否联网"选择：off / on / auto
          attachments,
        });
        streamDone = true;
        // 方案A：学习讲解完成后推送"练习卡片"（选择题 + 编程挑战），学生不离开对话即可做题
        if (result.card) sendEvent('card', locale.display(result.card));
        sendEvent('done', locale.display({ sessionId, ...result }));
      } catch (e) {
        if (controller.signal.aborted) return;
        // 错误也通过 SSE 事件下发，前端可明确提示，而不是断连后让前端卡在等待
        console.error('[stream error]', e.message);
        logger.error('sse_error', `[${sessionId}] 流式处理异常: ${e.message}`, { sessionId, message: message.slice(0, 60) });
        sendEvent('error', { message: locale.translate(String(e.message || '内部错误').slice(0, 300)) });
      } finally {
        streamDone = true;
        res.removeListener('close', onClose);
        if (!res.destroyed) res.end();
      }
      return;
    }

    if (p === '/api/course') {
      // 课程大纲：按会话绑定返回（默认 python-intro）；?courseId= 显式预览某课
      const builtinCourse = pickCourse(url);
      const sessionId = url.searchParams.get('sessionId') || 'default';
      const reqCourseId = url.searchParams.get('courseId');
      if (reqCourseId && reqCourseId !== course.id) {
        const dyn = courseRegistry.getDynamicCourse(reqCourseId);
        if (!dyn) { sendJSON(res, 404, { error: `课程不存在: ${reqCourseId}` }); return; }
        sendJSON(res, 200, {
          course: buildDynamicCourseView(dyn),
          learning: null, dynamic: true,
        });
        return;
      }
      // 先确保会话存在（getActiveCourse 内部会按会话 id 解析课程并初始化），再取学习状态
      const active = agent.getActiveCourse(sessionId);
      const info = agent.getSessionInfo(sessionId);
      const boundDyn = info && info.activeCourseId && info.activeCourseId !== course.id
        ? courseRegistry.getDynamicCourse(info.activeCourseId) : null;
      if (info && info.activeCourseId && info.activeCourseId !== course.id && !boundDyn) {
        agent.switchCourse(sessionId, course.id); // 动态课已被删除 → 回退内置
        const active2 = agent.getActiveCourse(sessionId);
        const info2 = agent.getSessionInfo(sessionId);
        sendJSON(res, 200, {
          course: translateBuiltinCourse(active2.course, url),
        learning: info2 ? info2.learning : null,
        dynamic: active2.dynamic,
        courseId: active2.course.id,
        });
        return;
      }
      sendJSON(res, 200, {
        course: translateBuiltinCourse(active.course, url),
        learning: info ? info.learning : null,
        dynamic: active.dynamic,
        courseId: active.course.id,
      });
      return;
    }

    if (p === '/api/course/switch' && req.method === 'POST') {
      // 切换会话绑定的课程（内置 python-intro ↔ user-* 动态课）
      const body = await readBody(req);
      const sessionId = String(body.sessionId || 'default');
      const courseId = String(body.courseId || '');
      const result = agent.switchCourse(sessionId, courseId);
      if (!result.ok) { sendJSON(res, 400, { error: result.error }); return; }
      const info = agent.getSessionInfo(sessionId);
      const active = agent.getActiveCourse(sessionId);
      sendJSON(res, 200, {
        ok: true,
        courseId: result.courseId,
        course: translateBuiltinCourse(active.course, url),
          learning: info ? info.learning : null,
          dynamic: active.dynamic,
      });
      return;
    }

    if (p === '/api/course/rename' && req.method === 'POST') {
      // 动态课程改名（仅 user-* 课程；内置课固定名）
      const body = await readBody(req);
      const courseId = String(body.courseId || '');
      const title = String(body.title || '').trim();
      if (!courseRegistry.isDynamicCourseId(courseId)) { sendJSON(res, 400, { error: '仅可修改用户上传的课程名称' }); return; }
      if (!title || title.length > 60) { sendJSON(res, 400, { error: '课程名称需为 1~60 字' }); return; }
      const dyn = courseRegistry.getDynamicCourse(courseId);
      if (!dyn) { sendJSON(res, 404, { error: `课程不存在: ${courseId}` }); return; }
      const meta = courseRegistry.renameCourse(courseId, title);
      logger.info('course_rename', `课程改名: ${courseId} → ${title}`);
      sendJSON(res, 200, { ok: true, courseId, title: meta.title });
      return;
    }

    if (p === '/api/course/delete' && req.method === 'POST') {
      // 删除动态课程（清理知识库产物 + 绑定会话回退内置）
      const body = await readBody(req);
      const courseId = String(body.courseId || '');
      if (!courseRegistry.isDynamicCourseId(courseId)) { sendJSON(res, 400, { error: '内置课程不可删除' }); return; }
      const dyn = courseRegistry.getDynamicCourse(courseId);
      if (!dyn) { sendJSON(res, 404, { error: `课程不存在: ${courseId}` }); return; }
      await kbUpload.cleanupCourse(courseId);
      agent.deleteDynamicCourse(courseId);
      logger.info('course_delete', `删除动态课程: ${courseId}《${dyn.title}》`);
      sendJSON(res, 200, { ok: true, courseId });
      return;
    }

    if (p === '/api/courses') {
      // 课程列表：内置 python-intro + 动态课程（user-*），动态课带 chunks/chapters 元信息
      const builtinCourse = pickCourse(url);
      const dynamic = courseRegistry.listDynamicCourses().map((c) => ({
        id: c.id, title: c.title, description: c.description,
        source: 'upload', chapterCount: c.chapterCount, chunkCount: c.chunkCount, createdAt: c.createdAt,
      }));
      sendJSON(res, 200, {
        courses: [
          { id: builtinCourse.id, title: builtinCourse.title, description: builtinCourse.description, source: 'builtin', chapterCount: builtinCourse.chapters.length },
          ...dynamic,
        ],
      });
      return;
    }

    if (p === '/api/kb/upload' && req.method === 'POST') {
      // 素材上传：raw body + filename（query 或 X-Filename 头）→ 建动态课程
      //   ?courseId=user-xxx  → 追加到该课程（批量上传合并成一门课）
      //   ?title=xxx           → 自定义课程名（默认文档标题/文件名）
      // 安全解码：畸形的百分号编码（如 %E0%A4%A）会让 decodeURIComponent 抛 URIError，
      // 外层 catch 会当成 500 返回——这里降级为空串，交给下面的 400 分支给明确提示。
      const safeDecode = (v) => { try { return decodeURIComponent(String(v || '')); } catch (_) { return ''; } };
      const filename = url.searchParams.get('filename') || safeDecode(req.headers['x-filename']);
      const courseId = url.searchParams.get('courseId') || undefined;
      const title = url.searchParams.get('title') || undefined;
      if (!filename) { sendJSON(res, 400, { error: '缺少 filename（query 参数或 X-Filename 请求头）' }); return; }
      logger.info('kb_upload', `上传素材开始: ${filename}${courseId ? ` → 追加到 ${courseId}` : '（新建课程）'}`);
      const streaming = String(req.headers.accept || '').includes('text/event-stream');
      let sendEvent;
      let heartbeat;
      try {
        const data = await readRawBody(req);
        if (streaming) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS,
          });
          res.flushHeaders();
          sendEvent = (event, value) => {
            if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(locale.display(value))}\n\n`);
          };
          heartbeat = setInterval(() => {
            if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
          }, 15000);
          res.on('close', () => clearInterval(heartbeat));
        }
        const result = await kbUpload.processUpload({ filename, data }, {
          courseId, title, onProgress: sendEvent ? (p) => sendEvent('progress', p) : undefined,
        });
        logger.info('kb_upload', `上传完成: ${result.courseId}《${result.title}》${result.chunkCount} 块 ${result.elapsedMs}ms`);
        if (sendEvent) { sendEvent('done', { ok: true, ...result }); res.end(); }
        else sendJSON(res, 200, { ok: true, ...result });
      } catch (e) {
        logger.error('kb_upload', `上传失败: ${e.message}`, { filename });
        // readRawBody 超限时挂了 status=413，别丢掉它；其余业务错误（格式不支持/解析失败）仍为 400
        if (sendEvent) { sendEvent('error', { error: e.message }); res.end(); }
        else sendJSON(res, e.status || 400, { error: e.message });
      } finally {
        clearInterval(heartbeat);
      }
      return;
    }

    if (p === '/api/attachments' && req.method === 'POST') {
      const safeDecode = (v) => { try { return decodeURIComponent(String(v || '')); } catch (_) { return ''; } };
      const sessionId = String(url.searchParams.get('sessionId') || req.headers['x-session-id'] || 'default');
      const filename = url.searchParams.get('filename') || safeDecode(req.headers['x-filename']);
      if (!filename) { sendJSON(res, 400, { error: '缺少 filename（query 参数或 X-Filename 请求头）' }); return; }
      try {
        const data = await readRawBody(req, attachmentStore.MAX_BYTES);
        const attachment = await attachmentStore.create({
          sessionId,
          filename,
          mime: req.headers['content-type'],
          data,
        });
        sendJSON(res, 200, { ok: true, attachment });
      } catch (e) {
        logger.error('attachment_upload', `聊天附件上传失败: ${e.message}`, { sessionId, filename });
        sendJSON(res, e.status || 400, { error: e.message });
      }
      return;
    }

    if (p.startsWith('/api/session/')) {
      const sessionId = decodeURIComponent(p.slice('/api/session/'.length));
      if (req.method === 'DELETE') {
        // 删除会话（重置该课程的对话/进度/记忆）
        agent.removeSession(sessionId);
        logger.info('session_delete', `删除会话: ${sessionId}`);
        sendJSON(res, 200, { ok: true, sessionId });
        return;
      }
      const info = agent.getSessionInfo(sessionId);
      if (!info) { sendJSON(res, 404, { error: '会话不存在' }); return; }
      sendJSON(res, 200, info);
      return;
    }

    // 联网模式偏好（首页"是否联网"开关）：off 不联网 / on 一定联网 / auto 自动
    if (p === '/api/webmode' && req.method === 'POST') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || 'default');
      const mode = agent.setWebMode(sessionId, body.webMode);
      sendJSON(res, 200, { ok: true, sessionId, webMode: mode });
      return;
    }

    if (p === '/api/sessions') {
      // 会话列表（后台轨迹用）：id/课程/最后活动/轮数/最后意图/最后 Agent
      const list = agent.listSessions().map((s) => {
        const cid = s.activeCourseId || course.id;
        return {
          id: s.id,
          courseId: cid,
          courseTitle: cid === course.id ? course.title : ((courseRegistry.getDynamicCourse(cid) || {}).title || cid),
          lastAt: s.turnLog.length ? s.turnLog[s.turnLog.length - 1].at : null,
          turns: s.turnLog.length,
          lastIntent: s.turnLog.length ? s.turnLog[s.turnLog.length - 1].intent : null,
          lastAgent: s.turnLog.length ? s.turnLog[s.turnLog.length - 1].agent : null,
        };
      }).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
      sendJSON(res, 200, { sessions: list });
      return;
    }

    if (p === '/api/health') {
      const usageEngine = require('./agent/usage');
      sendJSON(res, 200, { ok: true, version: require('../package.json').version, installationId, desktop: { enabled: desktopMode, clients: desktop?.count || 0 }, runtime: llm.runtimeInfo(), mcp: mcp.summary(), usage: usageEngine.summary() });
      return;
    }

    if (p === '/api/config') {
      // 前端可见的服务端约束（课程素材与聊天附件上传上限）。
      // 让上传页的"超限"提示与后端 MAX_MB 同源，避免 UPLOAD_MAX_MB 改过后两边不一致：
      // 前端硬编码 10MB 而后端放开到 50MB（或反之）都会让用户看到自相矛盾的提示。
      sendJSON(res, 200, {
        ok: true,
        uploadMaxMB: kbUpload.MAX_MB,
        uploadMaxBytes: kbUpload.MAX_BYTES,
        uploadAllowedExt: kbUpload.ALLOWED_EXT,
        chatAttachmentMaxMB: attachmentStore.MAX_MB,
        chatAttachmentMaxBytes: attachmentStore.MAX_BYTES,
        chatAttachmentAllowedExt: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.md', '.markdown', '.txt', '.json', '.docx', '.pdf', '.pptx'],
      });
      return;
    }

    if (p === '/api/mcp') {
      // MCP 接入状态（后台/诊断用）：Server 连接状态、工具目录、调用计数
      //   ?reload=1 强制重读 mcp.servers.json 并重连（凭据变更后可热更新）
      if (url.searchParams.get('reload') === '1') {
        mcp.start({ force: true }).catch((e) => logger.warn('mcp_reload', `重载失败: ${e.message}`));
      }
      sendJSON(res, 200, {
        ok: true,
        configFile: require('./mcp/config').CONFIG_FILE,
        summary: mcp.summary(),
        servers: mcp.status(),
        tools: mcp.toolNames(),
        // 前端"是否联网"开关用：哪些工具属于"联网检索类"（webMode=off 时会被隐藏）
        searchTools: mcp.toolNames().filter((n) => mcp.isSearchTool(n)),
      });
      return;
    }

    // ---- LLM 接入配置（首次进入的向导）----
    // 安全：这些接口能读改 API Key，只接受本机回环来源，或已通过服务令牌
    // 鉴权的请求（Docker 中宿主浏览器在容器内通常显示为桥接地址）。
    if (p === '/api/profile' && req.method === 'GET') {
      // 用户档案查询（uid 或 sessionId 均可 → 取 @ 前缀）
      const uid = url.searchParams.get('uid') || url.searchParams.get('sessionId') || '';
      sendJSON(res, 200, { profile: profileStore.getProfile(uid) });
      return;
    }

    // ---- LLM 接入配置（首次进入的向导）----
    // 安全：这些接口能读改 API Key，只接受本机回环来源。
    // 服务默认只监听 127.0.0.1（HOST），但若用户改成 0.0.0.0 暴露到局域网，
    // 这里就是最后一道闸门——否则同网段任何人都能读到/覆盖你的 Key。
    if (p.startsWith('/api/llm/')) {
      if (!canManageSecrets(req)) {
        logger.warn('llm_config', `拒绝非本机来源的配置请求: ${req.socket.remoteAddress}`);
        sendJSON(res, 403, { error: '配置接口仅允许本机访问（检测到远程请求）' });
        return;
      }
      if (p === '/api/llm/providers' && req.method === 'GET') {
        // 平台预设（含 baseUrl 与申请入口；不含任何密钥）
        sendJSON(res, 200, { providers: llmConfig.PROVIDERS });
        return;
      }
      if (p === '/api/llm/config' && req.method === 'GET') {
        // 当前生效配置（密钥一律掩码，明文永不回传）
        sendJSON(res, 200, { ok: true, config: llmConfig.getConfig(), runtime: llm.runtimeInfo() });
        return;
      }
      if (p === '/api/llm/models' && req.method === 'POST') {
        // 拉取模型列表：优先用请求里带的新 Key（还没保存就能预览模型）
        const body = await readBody(req);
        const r = await llmConfig.listModels({ provider: body.provider, baseUrl: body.baseUrl, apiKey: body.apiKey });
        logger.info('llm_models', r.ok ? `拉取到 ${r.count} 个模型` : `失败: ${r.error}`);
        sendJSON(res, r.ok ? 200 : 400, r);
        return;
      }
      if (p === '/api/llm/test' && req.method === 'POST') {
        // 保存前连通性测试：避免存了错的 Key，之后每轮对话都失败
        const body = await readBody(req);
        const r = await llmConfig.testConnection({ provider: body.provider, baseUrl: body.baseUrl, model: body.model, apiKey: body.apiKey, testVision: body.testVision === true });
        logger.info('llm_test', r.ok ? `连通正常（${r.elapsedMs}ms, ${r.model}）` : `失败: ${r.error}`);
        sendJSON(res, r.ok ? 200 : 400, r);
        return;
      }
      if (p === '/api/llm/save' && req.method === 'POST') {
        const body = await readBody(req);
        const r = llmConfig.saveConfig({
          provider: body.provider, baseUrl: body.baseUrl, model: body.model,
          apiKey: body.apiKey === undefined ? undefined : body.apiKey,
          disableThinking: body.disableThinking === undefined ? undefined : !!body.disableThinking,
        });
        if (!r.ok) { sendJSON(res, 400, r); return; }
        logger.info('llm_save', `LLM 配置已保存并热生效：${r.config.provider} / ${r.config.model}（无需重启）`);
        sendJSON(res, 200, { ok: true, config: r.config, runtime: llm.runtimeInfo() });
        return;
      }
      if (p === '/api/llm/skip' && req.method === 'POST') {
        // 用户选"先用离线演示"：记录标记，之后不再弹配置引导
        const r = llmConfig.skipSetup();
        sendJSON(res, r.ok ? 200 : 400, r);
        return;
      }
      sendJSON(res, 404, { error: '未知的配置接口' });
      return;
    }

    // ---- 联网检索配置 ----
    // Tavily key 与 LLM key 一样只允许本机页面读写；明文永不回传。
    if (p.startsWith('/api/web/')) {
      if (!canManageSecrets(req)) {
        logger.warn('web_config', `拒绝非本机来源的联网配置请求: ${req.socket.remoteAddress}`);
        sendJSON(res, 403, { error: '联网配置仅允许本机访问（检测到远程请求）' });
        return;
      }
      if (p === '/api/web/config' && req.method === 'GET') {
        sendJSON(res, 200, { ok: true, config: webConfig.getConfig() });
        return;
      }
      if (p === '/api/web/config' && req.method === 'POST') {
        const body = await readBody(req);
        const result = webConfig.saveConfig({
          enabled: body.enabled === true,
          apiKey: body.apiKey === undefined ? undefined : body.apiKey,
        });
        if (!result.ok) { sendJSON(res, 400, result); return; }
        // Recreate MCP children so a newly saved key is available immediately.
        const mcpResult = await mcp.start({ force: true });
        logger.info('web_config', `联网检索已${result.config.enabled ? '开启' : '关闭'}，Tavily MCP ${mcpResult.filter((item) => item.ok).length}/${mcpResult.length} 就绪`);
        sendJSON(res, 200, { ...result, mcp: mcp.summary() });
        return;
      }
      sendJSON(res, 404, { error: '未知的联网配置接口' });
      return;
    }


    if (p === '/api/profile' && req.method === 'POST') {
      // 设置/更新用户档案（本地单用户身份，非账号体系）
      const body = await readBody(req);
      const uid = String(body.uid || body.sessionId || '').trim();
      if (!uid) { sendJSON(res, 400, { error: '缺少 uid' }); return; }
      const result = profileStore.setProfile(uid, { nickname: body.nickname, avatar: body.avatar });
      if (!result.ok) { sendJSON(res, 400, { error: result.error }); return; }
      sendJSON(res, 200, { ok: true, profile: result.profile });
      return;
    }

    if (p === '/api/logs') {
      // 运行日志（后台页/排查用）：返回最近 N 条
      const n = Math.min(parseInt(url.searchParams.get('n') || '50', 10) || 50, 500);
      sendJSON(res, 200, { logs: logger.tail(n) });
      return;
    }

    if (p === '/api/run/python' && req.method === 'POST') {
      // 做题区：Python 代码沙箱试运行（P1）
      const body = await readBody(req);
      const code = String(body.code || '');
      if (!code.trim()) { sendJSON(res, 400, { error: '代码不能为空' }); return; }
      const result = await runner.runPython(code, { timeoutMs: body.timeoutMs || undefined });
      logger.info('run_python', `代码运行 ${result.rejected ? '被拦截' : result.timeout ? '超时' : `exit=${result.exitCode}`} | 输入 ${code.length} 字符`);
      sendJSON(res, 200, result);
      return;
    }

    if (p === '/api/coding/problems') {
      // 某单元的编程题列表（公开字段，不含测试检查表达式）
      const kpId = String(url.searchParams.get('kpId') || '');
      sendJSON(res, 200, { problems: problemsModule.getProblems(kpId) });
      return;
    }

    if (p === '/api/coding/quiz') {
      // 某单元选择题（来自 course 题库，前端本地判分）
      const kpId = String(url.searchParams.get('kpId') || '');
      const found = findKnowledgePoint(kpId);
      if (!found) { sendJSON(res, 200, { quiz: [] }); return; }
      sendJSON(res, 200, { quiz: found.kp.quiz || [] });
      return;
    }

    if (p === '/api/coding/submit' && req.method === 'POST') {
      // 提交判分：客观用例 + LLM 点评（P2）
      const body = await readBody(req);
      const kpId = String(body.kpId || '');
      const problemId = String(body.problemId || '');
      const code = String(body.code || '');
      const result = await grader.gradeSubmission(kpId, problemId, code);
      if (body.sessionId && !result.error) result.record = agent.recordCodingGrade(String(body.sessionId), kpId, problemId, result);
      logger.info('coding_submit', `提交 ${problemId} | ${result.error ? result.error : `通过 ${result.passed}/${result.total}`}`);
      sendJSON(res, 200, result);
      return;
    }

    if (p === '/api/coding/record' && req.method === 'POST') {
      // 做题区判分结果回写主会话学习状态（choice/coding → learning.kps.quizHistory + 卡点）
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      const r = agent.recordPracticeAnswer(sessionId, body);
      if (!r.ok) { sendJSON(res, 400, { error: r.error }); return; }
      logger.info('coding_record', `[${sessionId}] 做题记录 ${body.kind || 'choice'} 写入 kp=${body.kpId} correct=${r.correct}`);
      sendJSON(res, 200, r);
      return;
    }

    // ---- 错题本（对话内面板）：列表 / 删除 ----
    if (p === '/api/mistakes' && req.method === 'GET') {
      // 当前会话的全部答错记录（带题目/选项/标准答案，供"点开重练"）
      const sessionId = String(url.searchParams.get('sessionId') || 'default');
      sendJSON(res, 200, await agent.listMistakes(sessionId));
      return;
    }
    if (p === '/api/mistakes/delete' && req.method === 'POST') {
      // 按 id 删除错题记录（同时清掉该题沉淀的卡点）
      const body = await readBody(req);
      const sessionId = String(body.sessionId || 'default');
      const r = agent.deleteMistakes(sessionId, body.ids || []);
      if (!r.ok) { sendJSON(res, 400, r); return; }
      logger.info('mistake_delete', `[${sessionId}] 删除错题 ${r.removed} 条`);
      sendJSON(res, 200, r);
      return;
    }

    // ---- 期末大实践（混合卷：选择题 + 代码实践题，闭卷限时）----
    if (p === '/api/exam' && req.method === 'GET') {
      const s = agent.getSession(String(url.searchParams.get('sessionId') || 'default'));
      sendJSON(res, 200, exam.examSummary(s));
      return;
    }
    if (p === '/api/exam/start' && req.method === 'POST') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || 'default');
      const s = agent.getSession(sessionId);
      const r = exam.startExam(s);
      if (r.error) { sendJSON(res, 400, r); return; }
      sessionStore.save(s);
      logger.info('exam_start', `[${sessionId}] 期末大实践开考：${r.paper.choice.length} 选择题 + ${r.paper.coding.length} 编程题`);
      sendJSON(res, 200, r);
      return;
    }
    if (p === '/api/exam/leave' && req.method === 'POST') {
      // 闭卷约束：离开答题页仅记录次数（不直接作废，避免误伤切屏看时间）
      const body = await readBody(req);
      const s = agent.getSession(String(body.sessionId || 'default'));
      const r = exam.noteLeave(s);
      sessionStore.save(s);
      sendJSON(res, 200, r);
      return;
    }
    if (p === '/api/exam/submit' && req.method === 'POST') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || 'default');
      const s = agent.getSession(sessionId);
      const r = await exam.submitExam(s, { attemptId: body.attemptId, answers: body.answers, code: body.code });
      if (r.error) { sendJSON(res, 400, r); return; }
      sessionStore.save(s);
      logger.info('exam_submit', `[${sessionId}] 期末大实践交卷：得分 ${r.attempt.score}（通过=${r.passed}）离开 ${r.attempt.leftCount} 次`);
      sendJSON(res, 200, r);
      return;
    }

    // 静态资源
    serveStatic(req, res, p);
  } catch (e) {
    if (!res.destroyed && !res.headersSent) sendJSON(res, e.status || 500, { error: e.message });
  } finally {
    activeRequests--;
  }
}));

let stoppingDesktop = false;
function stopDesktop() {
  if (stoppingDesktop) return;
  stoppingDesktop = true;
  console.log('[desktop] Stopping the local service.');
  desktop?.close();
  server.close();
  server.closeIdleConnections();
  // Let already accepted work save its result, with a bounded shutdown period.
  let finishing = false;
  async function finish() {
    if (finishing) return;
    finishing = true;
    clearInterval(draining);
    clearTimeout(deadline);
    require('./kb/embed').closeLocal();
    const forceExit = setTimeout(() => process.exit(0), 5000);
    await mcp.stop();
    sessionStore.getDb().close();
    clearTimeout(forceExit);
    process.exit(0);
  }
  const deadline = setTimeout(finish, 30000);
  const draining = setInterval(() => { if (!activeRequests) finish(); }, 100);
}

// The native app owns service lifetime; browser navigation never shuts it down.
if (process.send) {
  process.on('message', message => { if (message?.type === 'edupilot:shutdown') stopDesktop(); });
  process.on('disconnect', stopDesktop);
}

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  EduPilot 学习向导 · 教育智能体 已启动');
  console.log(`  访问地址: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (auth.configuredToken()) {
    console.log('  API 鉴权: 已启用（Bearer / X-Auth-Token / Basic）');
  } else {
    console.log('  API 鉴权: 未启用（仅允许本机回环监听）');
  }
  console.log(`  LLM 模式: ${llm.runtimeInfo().label}`);
  console.log(`  提示: LLM 配置在 .env 文件（LLM_API_KEY / LLM_MODEL）`);
  console.log('==============================================');
  // MCP Server 拉起（后台执行，失败只记日志，不影响 Web 服务）
  mcp.start()
    .then((results) => {
      const ok = results.filter((r) => r.ok);
      if (results.length) {
        console.log(`  MCP: ${ok.length}/${results.length} 个 Server 就绪 → ${mcp.toolNames().join(', ') || '无工具'}`);
      }
    })
    .catch((e) => {
      console.warn('[mcp] 启动异常（已忽略）:', e.message);
      logger.warn('mcp_start', `启动异常: ${e.message}`);
    });
});
