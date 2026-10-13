/**
 * kb/quiz-gen.js — 素材课（用户上传教材）配套题目生成
 * ------------------------------------------------------------------
 * 背景：内置课自带题库；素材课原本无题库，只能自由问答 —— 因此无法练习、
 * 无法检测、也无法参加期末大实践。本模块用 LLM 从教材片段自动命题，把
 * 素材课补齐成与内置课同构的形态（同样是「节 = 知识点」，同样走严格梯级）。
 *
 * 新上传课程：lesson-gen 在发布前生成讲义和题目，本模块直接读取版本内题库。
 * 旧课程：保留 preGenerate / getQuiz 的缓存与按需生成兼容路径。
 *
 * 缓存：data/courses/<courseId>.quizzes.json
 *   { [learningKey]: { title, chapter, generatedAt, questions: [{q, options, answer, explanation, source}] } }
 *   （learningKey 与 course-registry.learningKey 完全同源，即 learning.kps 的 key）
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const llm = require('../agent/llm');
const kbSearch = require('./search');
const courseRegistry = require('./course-registry');

const COURSES_DIR = path.join(__dirname, '..', '..', 'data', 'courses');
const PER_SECTION = 3;      // 每节生成的选择题数量
const MAX_CONTEXT = 4000;   // 单节喂给模型的教材片段上限（字符）
const PRE_CONCURRENCY = 2;  // 预生成并发（避免打满 LLM 配额）

const cachePath = (cid) => path.join(COURSES_DIR, `${cid}.quizzes.json`);
const versionOf = (cid) => courseRegistry.getDynamicCourse(cid)?.indexVersion || null;

function readCache(cid) {
  const course = courseRegistry.getDynamicCourse(cid);
  // New uploads publish lessons and their question banks in one registry commit.
  if (course?.learningReady && course.lessons) return course.lessons;
  try {
    const raw = fs.readFileSync(cachePath(cid), 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return {};
    return Object.fromEntries(Object.entries(j).filter(([, entry]) => (entry.indexVersion || null) === versionOf(cid)));
  } catch (_) { return {}; }
}

function writeCache(cid, data) {
  const temporary = cachePath(cid) + '.' + randomUUID() + '.tmp';
  try {
    fs.mkdirSync(COURSES_DIR, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(temporary, cachePath(cid));
    return true;
  } catch (_) { return false; }
  finally { fs.rmSync(temporary, { force: true }); }
}

/** 缓存里是否有该节的题目 */
function hasQuiz(cid, key) {
  const q = readCache(cid)[key];
  return !!(q && Array.isArray(q.questions) && q.questions.length);
}

/** 同步读缓存（不触发生成）：考试组卷 / 报告 / 前端列表用 */
function cachedQuiz(cid, key) {
  const q = readCache(cid)[key];
  return q && Array.isArray(q.questions) && q.questions.length ? q : null;
}

/** 整门课已缓存的题目数（用于展示"题目准备进度"） */
function cacheStats(cid) {
  const cache = readCache(cid);
  const keys = Object.keys(cache);
  const questions = keys.reduce((n, k) => n + ((cache[k].questions || []).length), 0);
  return { sections: keys.length, questions };
}

/** 取该节的教材片段：优先按 learningKey 精确取该节 chunk，取不到再按标题检索 */
async function sectionContext(cid, key, chapterTitle, sectionTitle) {
  const query = [chapterTitle, sectionTitle].filter(Boolean).join(' ');
  let hits = [];
  try {
    hits = await kbSearch.searchHybrid(query || key, { courseId: cid, kpId: key, topK: 6 });
  } catch (_) {}
  if (!hits || !hits.length) {
    try {
      hits = await kbSearch.searchHybrid(query || key, { courseId: cid, topK: 3 });
    } catch (_) {}
  }
  const text = (hits || [])
    .map((h) => String(h.text || h.content || h.snippet || '').trim())
    .filter(Boolean)
    .join('\n---\n');
  return text.slice(0, MAX_CONTEXT);
}

/** 从模型输出里抽出题目数组（容忍 ```json 包裹与前后杂文） */
function parseQuestions(raw) {
  const text = String(raw || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/\[/);
  if (start < 0) return [];
  // 括号配平扫描（字符串内的括号不计数）
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          const arr = JSON.parse(body.slice(start, i + 1));
          return Array.isArray(arr) ? arr : [];
        } catch (_) { return []; }
      }
    }
  }
  return [];
}

/** 校验并规范化单题：4 选项 + 字母答案（与内置题库同构） */
function normalize(item) {
  if (!item || !item.q) return null;
  const options = (Array.isArray(item.options) ? item.options : []).map((o) => String(o).trim()).filter(Boolean);
  if (options.length !== 4 || new Set(options).size !== 4) return null;
  let answer = String(item.answer || '').trim().toUpperCase();
  if (!/^[ABCD]$/.test(answer)) {
    // 模型可能直接给了选项文本 → 反查下标
    const idx = options.findIndex((o) => o === String(item.answer || '').trim());
    if (idx < 0) return null;
    answer = String.fromCharCode(65 + idx);
  }
  if (answer.charCodeAt(0) - 65 >= options.length) answer = 'A';
  return {
    q: String(item.q).trim().slice(0, 300),
    options: options.slice(0, 4),
    answer,
    explanation: String(item.explanation || '').trim().slice(0, 400),
  };
}

/** 用 LLM 为该节命题并写缓存 */
async function generate(cid, key, meta = {}) {
  const course = courseRegistry.getDynamicCourse(cid);
  if (!course) return null;
  const indexVersion = versionOf(cid);
  const context = await sectionContext(cid, key, meta.chapterTitle, meta.sectionTitle);
  if (versionOf(cid) !== indexVersion || !courseRegistry.getDynamicCourse(cid)) return null;
  if (!context) return null;
  const where = [meta.chapterTitle, meta.sectionTitle].filter(Boolean).join(' · ');
  const prompt = [
    require('../locale').english()
      ? 'Create single-answer multiple-choice questions in English from the following course excerpts.'
      : '你是命题老师，请根据下面的教材片段出单项选择题（中文）。',
    `题目数量：${PER_SECTION} 道；考点必须**全部来自片段内容**，不要考片段外的知识。`,
    '要求：选项互斥且只有一个正确；干扰项要合理；解析一句话说明为什么；难度适合初学者。',
    '严格输出 JSON 数组（不要任何解释文字）：',
    '[{"q":"题干","options":["选项A","选项B","选项C","选项D"],"answer":"A","explanation":"解析"}]',
    '',
    `【教材片段｜${where}】`,
    context,
  ].join('\n');
  let questions = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (versionOf(cid) !== indexVersion || !courseRegistry.getDynamicCourse(cid)) return null;
    const raw = await llm.callApi([{ role: 'user', content: prompt + (attempt ? `\n上次输出只有 ${questions.length} 道通过格式校验。请重新输出完整的 ${PER_SECTION} 道不同题目，答案只能是 A/B/C/D，每题四个不同选项。` : '') }]);
    if (versionOf(cid) !== indexVersion || !courseRegistry.getDynamicCourse(cid)) return null;
    questions = parseQuestions(raw).map(normalize).filter(Boolean).filter((q, i, all) => all.findIndex(other => other.q === q.q) === i).slice(0, PER_SECTION);
    if (questions.length === PER_SECTION) break;
  }
  if (questions.length !== PER_SECTION) return null;
  if (versionOf(cid) !== indexVersion || !courseRegistry.getDynamicCourse(cid)) return null;
  const cache = readCache(cid);
  cache[key] = {
    title: meta.sectionTitle || meta.chapterTitle || '本节练习',
    chapter: meta.chapterTitle || '',
    generatedAt: new Date().toISOString(),
    indexVersion,
    questions,
  };
  writeCache(cid, cache);
  return cache[key];
}

/** 对外：取该节题目（缓存优先 → 当场生成并落盘）；失败返回 null */
const pending = new Map();
async function getQuiz(cid, key, meta = {}) {
  const hit = cachedQuiz(cid, key);
  if (hit) return hit;
  const jobKey = JSON.stringify([cid, versionOf(cid), key]);
  if (pending.has(jobKey)) return pending.get(jobKey);
  const job = generate(cid, key, meta).catch(e => {
    console.warn('[quiz-gen] 生成失败:', e.message);
    return null;
  }).finally(() => pending.delete(jobKey));
  pending.set(jobKey, job);
  return job;
}

/** 该节题目对应的章节标题（用于生成时提供上下文） */
function metaOfSection(cid, key) {
  const dyn = courseRegistry.getDynamicCourse(cid);
  if (!dyn) return {};
  const view = courseRegistry.dynamicCourseView(dyn);
  for (const ch of view.chapters) {
    for (const kp of ch.knowledgePoints) {
      if (kp.id === key) {
        const multi = ch.knowledgePoints.length > 1;
        return { chapterTitle: ch.title, sectionTitle: multi ? kp.title : '' };
      }
    }
  }
  return {};
}

const preGenerating = new Set();

/**
 * 后台预生成整门课的题目（上传完成后调用，不阻塞响应）。
 * 逐节串行 + 小并发；已缓存的跳过；失败不重试（交给按需生成兜底）。
 */
function preGenerate(cid) {
  const dyn = courseRegistry.getDynamicCourse(cid);
  if (!dyn) return Promise.resolve({ skipped: true });
  const version = versionOf(cid);
  const jobKey = `${cid}:${version}`;
  if (preGenerating.has(jobKey)) return Promise.resolve({ skipped: true });
  preGenerating.add(jobKey);
  const view = courseRegistry.dynamicCourseView(dyn);
  const tasks = [];
  for (const ch of view.chapters) {
    const multi = ch.knowledgePoints.length > 1;
    for (const kp of ch.knowledgePoints) {
      tasks.push({ key: kp.id, chapterTitle: ch.title, sectionTitle: multi ? kp.title : '' });
    }
  }
  return (async () => {
    let done = 0, generated = 0, failed = 0;
    const queue = tasks.slice();
    const worker = async () => {
      while (queue.length && versionOf(cid) === version && courseRegistry.getDynamicCourse(cid)) {
        const t = queue.shift();
        if (hasQuiz(cid, t.key)) { done += 1; continue; }
        const r = await getQuiz(cid, t.key, t);
        done += 1;
        if (r) generated += 1; else failed += 1;
      }
    };
    await Promise.all(Array.from({ length: PRE_CONCURRENCY }, worker));
    preGenerating.delete(jobKey);
    console.log(`[quiz-gen] ${cid} 预生成完成：新生成 ${generated} 节 / 共 ${tasks.length} 节，失败 ${failed}`);
    return { total: tasks.length, generated, failed };
  })();
}

module.exports = { getQuiz, cachedQuiz, hasQuiz, cacheStats, preGenerate, metaOfSection, PER_SECTION, _parseQuestions: parseQuestions, _normalize: normalize };
