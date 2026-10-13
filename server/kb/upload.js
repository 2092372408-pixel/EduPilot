/**
 * upload.js — 素材上传编排（上传方案 v2 · U2）
 * ------------------------------------------------------------
 * 流程（设计方案 §三）：
 *   ① 扩展名路由：md 直读 / json 扁平化 / docx|pdf|pptx → convert.js（spawn Python MarkItDown）
 *   ② 规范化 Markdown：convert.js 已规整标题层级 / 空块 / 超长行
 *   ③ 写入 data/kb/books/{courseId}/（courseId = user-<时间戳>）
 *   ④ 复用构建管线：import.buildCourse（分章切块）→ chunks.json + index.json（课程隔离）
 *      → buildVectors（向量化，无 Key 自动跳过 → BM25 兜底）
 *   ⑤ 逐节生成教学讲义和题目、原文审核 → 全部就绪后原子注册课程
 *   → 返回 { courseId, title, chapterCount, chunkCount, elapsedMs, warnings }
 *
 * 批量追加模式：传 opts.courseId（已有动态课）→ 追加为新的一篇，重建索引与注册表，
 * 供"上传页一次传多个文件 → 合并成同一门课"使用。
 *
 * 安全：扩展名白名单、≤MAX_MB（默认 10MB）、文件名消毒、解析失败/异常时清理残留产物。
 */

require('../env');

const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('node:crypto');
const { courseFiles } = require('./snapshots');
const { withCourseLock } = require('./course-lock');
const { convertToMarkdown } = require('./convert');
const { buildCourse } = require('./import');
const { buildVectors } = require('./build-vectors');
const { EMBED_PROVIDER } = require('./embed');
const { registerCourse, unregisterCourse, getDynamicCourse, removeOrTrash } = require('./course-registry');

const KB_ROOT = path.join(__dirname, '..', '..', 'data', 'kb');
const BOOKS_DIR = path.join(KB_ROOT, 'books');
const COURSES_DIR = path.join(__dirname, '..', '..', 'data', 'courses');

const ALLOWED_EXT = ['.md', '.markdown', '.txt', '.json', '.docx', '.pdf', '.pptx'];
// 单文件大小上限（默认 10MB）：教材/讲义单册通常远小于此；
// 上限主要受「解析 + 切块 + 向量化」耗时约束（实测 1MB≈46s、5MB≈228s），
// 10MB 是「够用」与「不至于让上传等待过久」的折中，可用 UPLOAD_MAX_MB 覆盖。
const MAX_MB = Number(process.env.UPLOAD_MAX_MB) > 0 ? Number(process.env.UPLOAD_MAX_MB) : 10;
const MAX_BYTES = MAX_MB * 1024 * 1024;
/**
 * 解析后 Markdown 的字符上限。
 * 必须与 MAX_BYTES 口径一致：中文 UTF-8 每字 3 字节，10MB 文件约 330 万字。
 * 若这里卡在 200 万字符（≈6MB 中文），10MB 字节上限就永远走不到、形同虚设
 * （实测 9MB 中文文件会被这里拦下并报"解析内容过大"）。
 * 取 MAX_BYTES 作为字符上限：纯 ASCII 文件最多 1000 万字符，中文约 330 万，
 * 既不会成为更严的那道限制，又能挡住"小体积、高膨胀"的异常文件。
 */
const MAX_MD_CHARS = Math.max(MAX_BYTES, 2_000_000);

/** 文件名消毒：保留中文/字母数字/-_，其余换 _；防路径穿越 */
function sanitizeName(name) {
  const base = path.basename(String(name || '')).replace(/\.(md|markdown|txt|json|docx|pdf|pptx)$/i, '');
  const clean = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60);
  return clean || 'material';
}

/** 清理动态课程的所有残留产物（books/chunks/题库缓存/注册表；删除被拦截时移入 trash） */
async function cleanupCourse(courseId) {
  courseFiles(courseId); // Validate before resolving deletion targets.
  if (!courseId.startsWith('user-')) throw new Error('只能删除素材课程');
  return withCourseLock(courseId, async () => {
  for (const dir of [path.join(BOOKS_DIR, courseId), path.join(KB_ROOT, 'chunks', courseId), path.join(KB_ROOT, 'versions', courseId)]) {
    if (fs.existsSync(dir)) removeOrTrash(dir);
  }
  // 题库缓存 data/courses/<id>.quizzes.json：原实现漏清，删课后会留下孤儿文件
  const quizCache = path.join(COURSES_DIR, `${courseId}.quizzes.json`);
  if (fs.existsSync(quizCache)) removeOrTrash(quizCache);
  unregisterCourse(courseId);
  require('./search').invalidate(courseId);
  });
}

/**
 * 处理上传素材（支持批量追加：opts.courseId 指向已有动态课 → 合并进同一门课）
 * @param {{ filename: string, data: Buffer }} upload
 * @param {{ courseId?: string, title?: string, onProgress?: function }} opts
 *   - 无 courseId：新建动态课程（courseId = user-时间戳-随机后缀）
 *   - 有 courseId：追加到该课程（新文件成为该课的一篇 book，重建索引/注册表）
 *   - title：课程标题覆盖（新建时自定义课程名；追加时可改名）
 * @returns {Promise<{courseId, title, docId, appended, bookCount, chapterCount, chunkCount, elapsedMs, warnings}>}
 */
async function processUpload(upload, opts = {}) {
  const started = Date.now();
  const filename = String(upload.filename || '');
  const ext = path.extname(filename).toLowerCase();

  // --- 安全校验 ---
  if (!ext) throw new Error('缺少文件扩展名');
  if (!ALLOWED_EXT.includes(ext)) {
    throw new Error(`不支持的文件格式 .${ext}（支持：docx / pdf / pptx / md / json / txt）`);
  }
  if (!upload.data || !upload.data.length) throw new Error('文件内容为空');
  if (upload.data.length > MAX_BYTES) throw new Error(`文件过大：超过 ${MAX_MB}MB 上限（当前 ${(upload.data.length / 1048576).toFixed(1)}MB）。请压缩或拆分后重新上传`);

  const warnings = [];
  const docId = sanitizeName(filename);

  // 追加模式：目标课程必须是已存在的动态课
  const appendCourseId = String(opts.courseId || '');
  let appended = false;
  let courseId = `user-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`;
  if (appendCourseId && appendCourseId.startsWith('user-')) {
    const target = getDynamicCourse(appendCourseId);
    if (!target) throw new Error(`要追加的课程不存在: ${appendCourseId}`);
    courseId = appendCourseId;
    appended = true;
  }
  courseFiles(courseId);
  return withCourseLock(courseId, async () => {
  const prev = getDynamicCourse(courseId);
  if (appended && !prev) throw new Error(`要追加的课程不存在: ${courseId}`);
  const previousFiles = courseFiles(courseId, prev);
  const tempRoot = path.join(KB_ROOT, '.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(tempRoot, courseId + '-'));
  const bookDir = path.join(tmpDir, 'books');
  const chunksDir = path.join(tmpDir, 'chunks');
  const tmpFile = path.join(tmpDir, 'source' + ext);
  let publishedDir = null;
  let activated = false;
  try {
    if (prev && fs.existsSync(previousFiles.books)) fs.cpSync(previousFiles.books, bookDir, { recursive: true });
    else fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(tmpFile, upload.data);
    const progress = (event) => { if (opts.onProgress) opts.onProgress(event); };
    progress({ stage: 'parsing' });

    // ① ② 转换 + 规范化（AnyDoc 本地子进程，必要时回退 Python MarkItDown）
    // fallbackTitle=真实文件名：文档无一级标题时课程名/章名用文件名，而非临时文件名里的 courseId 噪音
    const { markdown, docTitle, warnings: convWarnings } = await convertToMarkdown(tmpFile, { fallbackTitle: docId, onProgress: progress });
    if (convWarnings.length) warnings.push(...convWarnings);
    if (markdown.length > MAX_MD_CHARS) {
      throw new Error(`解析内容过大（约 ${Math.round(markdown.length / 10000)} 万字，超过 ${Math.round(MAX_MD_CHARS / 10000)} 万上限）。请拆分文件后重新上传`);
    }

    // ③ 教材落盘（docId = 消毒后文件名；同课内同名文件会被覆盖——按"重传更新"处理）
    const mdPath = path.join(bookDir, `${docId}.md`);
    fs.writeFileSync(mdPath, markdown, 'utf8');

    // ④ 构建知识库（动态课程：不写全局 index/questions——questions.json 属内置题库 python-intro；
    //    不映射内置知识点 kpId——动态课内容与 python-intro 无关）
    progress({ stage: 'chunking' });
    const index = buildCourse(courseId, { includeQuiz: false, includeIndex: true, mapKp: false, bookDir, outDir: chunksDir });
    const structure = {
      chapterCount: index.books.reduce((n, b) => n + b.chapters.length, 0),
      sectionCount: index.books.reduce((n, b) => n + b.chapters.reduce((m, ch) => m + ch.sections.length, 0), 0),
      chunkCount: index.chunkCount,
    };
    progress({ stage: 'chunking', ...structure });

    // 向量化（无 DASHSCOPE_API_KEY 内部自动跳过并打印，不抛错；失败降级 BM25，课程仍可用）
    for (const name of ['vectors.json', 'vectors.meta.json']) {
      const old = path.join(previousFiles.chunks, name);
      if (prev && fs.existsSync(old)) fs.copyFileSync(old, path.join(chunksDir, name));
    }
    const vec = await buildVectors(courseId, { directory: chunksDir, onProgress: (p) => progress({ ...p, ...structure }) });
    if (!vec?.ok) {
      for (const name of ['vectors.json', 'vectors.meta.json']) fs.rmSync(path.join(chunksDir, name), { force: true });
    }
    if (vec && vec.ok === false && vec.error) warnings.push('向量化失败（' + vec.error + '），已降级为关键词检索');
    if (EMBED_PROVIDER === 'auto') warnings.push('自动 provider 的向量来源无法固定，检索使用 BM25；启用混合检索请显式选择 local、dashscope 或 siliconflow 后重建');

    // ⑤ 注册动态课程（title：自定义标题 > 文档标题 > 文件名；追加时保留原课程名，除非显式传入 title）
    const kbIndex = JSON.parse(fs.readFileSync(path.join(chunksDir, 'index.json'), 'utf8'));
    // 两级章节结构：章 → 节。chapters 每项 = 一章（含 sections 小节列表；无小节时 chunks 直接挂章）
    const chapters = kbIndex.books.flatMap((b) =>
      b.chapters.map((ch) => ({
        docId: b.docId,
        title: ch.title,
        kpId: ch.kpId || null,
        sections: (ch.sections || []).map((s) => ({ title: s.title, chunks: s.chunks })),
        chunks: ch.chunks || [],
      }))
    );
    const baseTitle = opts.title && opts.title.trim()
      ? String(opts.title).trim().slice(0, 60)
      : (prev && prev.title) || docTitle || docId;
    const courseMeta = {
      id: courseId,
      title: baseTitle,
      description: `用户上传素材《${baseTitle}》（${kbIndex.books.length} 篇 / ${chapters.length} 章 / ${index.chunkCount} 块内容）`,
      source: 'upload',
      createdAt: (prev && prev.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      builtAt: index.builtAt,
      bookCount: kbIndex.books.length,
      chapterCount: chapters.length,
      chunkCount: index.chunkCount,
      chapters,
      indexVersion: randomUUID(),
      retrievalMode: vec?.ok && EMBED_PROVIDER !== 'auto' ? 'hybrid' : 'bm25',
    };
    const generated = await require('./lesson-gen').generateLessons(courseMeta,
      JSON.parse(fs.readFileSync(path.join(chunksDir, 'chunks.json'), 'utf8')), prev,
      (p) => progress({ ...p, ...structure }));
    Object.assign(courseMeta, generated, { learningReady: true });
    progress({ stage: 'saving', ...structure, ...generated.generation });
    const manifest = { version: 1, courseId, indexVersion: courseMeta.indexVersion, parser: 'convert-v1 (AnyDoc 0.2.4 / MarkItDown fallback / text)', splitter: 'chapter-section-v2', retrievalMode: courseMeta.retrievalMode,
      hashes: Object.fromEntries(fs.readdirSync(chunksDir).map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(chunksDir, name))).digest('hex')])) };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.rmSync(tmpFile, { force: true });
    publishedDir = courseFiles(courseId, courseMeta).directory;
    fs.mkdirSync(path.dirname(publishedDir), { recursive: true });
    fs.renameSync(tmpDir, publishedDir);
    registerCourse(courseMeta);
    activated = true;

    // ⑥ 失效检索缓存（追加/重建后 loadKB 缓存的是旧 chunks，必须清掉才能搜到新内容）
    require('./search').invalidate(courseId);

    console.log(`✅ 动态课程${appended ? '追加' : '创建'} [${courseId}]《${courseMeta.title}》：${index.chunkCount} 块 / ${chapters.length} 章`);
    return {
      courseId,
      title: courseMeta.title,
      docId,
      appended,
      description: courseMeta.description,
      bookCount: kbIndex.books.length,
      chapterCount: chapters.length,
      chunkCount: index.chunkCount,
      elapsedMs: Date.now() - started,
      warnings,
      indexVersion: courseMeta.indexVersion,
      retrievalMode: courseMeta.retrievalMode,
      learningReady: true,
      generation: courseMeta.generation,
    };
  } catch (e) {
    if (publishedDir && !activated && fs.existsSync(publishedDir)) removeOrTrash(publishedDir);
    throw e;
  } finally {
    if (fs.existsSync(tmpDir)) removeOrTrash(tmpDir);
  }
  });
}

module.exports = { processUpload, ALLOWED_EXT, MAX_BYTES, MAX_MB, cleanupCourse, COURSES_DIR };
