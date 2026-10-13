/**
 * import.js — 知识库构建脚本（教材 Markdown → 切块 + 索引 + 题库）
 * ------------------------------------------------------------
 * 用法：node server/kb/import.js [courseId]
 * 流程：
 *   1. 扫描 data/kb/books/<course>/*.md（教材原文）
 *   2. 按 "# 标题" 分文档、按 "## 标题" 切块（块超长时按段落再切）
 *   3. 章节标题关键词 → 映射知识点 kpId（与 course.js 对齐）
 *   4. 输出 data/kb/chunks/<course>/chunks.json + data/kb/index.json
 *   5. 从 course.js 导出题库 → data/kb/questions.json
 *
 * 设计原则：切块带元数据（docId/chapter/section/kpId），供检索溯源；
 *          脚本幂等，改教材后重新执行即可重建。
 */

const fs = require('fs');
const path = require('path');
const { course } = require('../data/course');
const { learningKey } = require('./course-registry');
const { fencedLines } = require('./fenced-lines');

const KB_ROOT = path.join(__dirname, '..', '..', 'data', 'kb');
const BOOKS_DIR = path.join(KB_ROOT, 'books');
const CHUNKS_DIR = path.join(KB_ROOT, 'chunks');
const MAX_BLOCK = 500; // 单块最大字符数

/** 章节标题 → 知识点映射（关键词命中，与 course.js 的 kp 对齐） */
const KP_MAP = [
  ['变量', 'kp1'], ['赋值', 'kp1'],
  ['数据类型', 'kp2'], ['类型', 'kp2'],
  ['条件', 'kp3'], ['判断', 'kp3'],
  ['循环', 'kp4'],
  ['函数', 'kp5'],
  ['列表', 'kp6'], ['字典', 'kp6'],
  ['面向对象', 'kp7'], ['类', 'kp7'], ['对象', 'kp7'],
];

function matchKp(title) {
  for (const [kw, kpId] of KP_MAP) {
    if (title.includes(kw)) return kpId;
  }
  return null;
}

/** 把章节文本切成块：代码块独立成块，长文本按 MAX_BLOCK 截断（尽量在段落边界） */
function splitIntoBlocks(text) {
  const blocks = [];
  let buffer = '';

  const flush = () => {
    const t = buffer.trim();
    if (t) blocks.push(t);
    buffer = '';
  };

  for (const { line, code, opening, closing } of fencedLines(text)) {
    if (opening) flush();
    buffer += line + '\n';
    if (closing || (!code && buffer.length > MAX_BLOCK)) flush();
  }
  flush();
  return blocks;
}

function buildCourse(courseId, opts = {}) {
  const includeQuiz = opts.includeQuiz !== false;
  const includeIndex = opts.includeIndex !== false;
  // 素材课用自身 doc/章/节的稳定 key，与学习状态和按节检索同源。
  const mapKp = opts.mapKp !== false;
  const bookDir = opts.bookDir || path.join(BOOKS_DIR, courseId);
  if (!fs.existsSync(bookDir)) {
    console.error(`❌ 未找到教材目录: ${bookDir}`);
    throw new Error(`未找到教材目录: ${bookDir}`);
  }

  const files = fs.readdirSync(bookDir).filter((f) => f.endsWith('.md')).sort();
  const chunks = [];
  const bookMap = new Map();

  for (const file of files) {
    const docId = path.basename(file, '.md');
    const raw = fs.readFileSync(path.join(bookDir, file), 'utf8');
    let docTitle = docId;
    let curChapter = null;   // 章标题（##）
    let curSection = null;   // 节标题（###，仅动态课识别）
    let curKp = null;
    let curLines = [];

    const flushChapter = () => {
      if (curChapter === null || !curLines.length) return;
      const text = curLines.join('\n').trim();
      if (!text) return;
      for (const block of splitIntoBlocks(text)) {
        chunks.push({
          chunkId: `chunk-${chunks.length + 1}`,
          docId,
          chapter: curChapter,
          section: curSection, // 节标题（###）；无节时为 null
          kpId: mapKp ? curKp : learningKey(docId, curChapter, curSection || ''),
          content: block,
        });
      }
      curLines = [];
    };

    for (const { line, code } of fencedLines(raw)) {
      if (code) {
        curLines.push(line);
      } else if (line.startsWith('# ')) {
        docTitle = line.slice(2).trim();
      } else if (line.startsWith('### ')) {
        // 节标题：仅动态课（mapKp=false）启用两级；内置课无 ### 不受影响
        flushChapter();
        curSection = line.slice(4).trim();
      } else if (line.startsWith('## ')) {
        flushChapter();
        curChapter = line.slice(3).trim();
        curSection = null; // 新章开始，节重置
        curKp = mapKp ? matchKp(curChapter) : null;
      } else {
        curLines.push(line);
      }
    }
    flushChapter();

    // 汇总书籍章节索引（两级：章 → 节）
    const book = { docId, title: docTitle, chapters: [] };
    bookMap.set(docId, book);
  }

  // 章节索引（按 docId + chapter 聚合，章下挂节）
  for (const c of chunks) {
    const book = bookMap.get(c.docId);
    if (!book) continue;
    let ch = book.chapters.find((x) => x.title === c.chapter);
    if (!ch) {
      ch = { title: c.chapter, kpId: c.kpId, sections: [], chunks: [] };
      book.chapters.push(ch);
    }
    if (c.section) {
      let sec = ch.sections.find((x) => x.title === c.section);
      if (!sec) { sec = { title: c.section, chunks: [] }; ch.sections.push(sec); }
      sec.chunks.push(c.chunkId);
    } else {
      ch.chunks.push(c.chunkId); // 无节的章内容直接挂在章下（向后兼容存量）
    }
  }

  const index = {
    courseId,
    builtAt: new Date().toISOString(),
    chunkCount: chunks.length,
    books: [...bookMap.values()],
  };

  // 落盘：index.json 按课程隔离（chunks/<course>/index.json），
  // python-intro 兼容旧布局额外写全局 data/kb/index.json（历史调用点仍读它）
  const outDir = opts.outDir || path.join(CHUNKS_DIR, courseId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'chunks.json'), JSON.stringify(chunks, null, 2), 'utf8');
  if (includeIndex) {
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
    if (courseId === 'python-intro') {
      fs.writeFileSync(path.join(KB_ROOT, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
    }
  }

  let questions = [];
  if (includeQuiz) {
    // 题库：从 course.js 导出（测试库阶段与知识点保持一致）
    for (const ch of course.chapters) {
      for (const kp of ch.knowledgePoints) {
        for (const q of kp.quiz || []) {
          questions.push({ ...q, kpId: kp.id, kpTitle: kp.title, chapter: ch.title });
        }
      }
    }
    fs.writeFileSync(path.join(KB_ROOT, 'questions.json'), JSON.stringify({ courseId, count: questions.length, questions }, null, 2), 'utf8');
  }
  console.log(`✅ 知识库构建完成 [${courseId}]`);
  console.log(`   - 教材: ${files.length} 篇`);
  console.log(`   - 切块: ${chunks.length} 块`);
  console.log(`   - 题目: ${questions.length} 道`);
  console.log(`   - 索引: data/kb/index.json`);
  return index;
}

if (require.main === module) {
  const courseId = process.argv[2] || 'python-intro';
  buildCourse(courseId);
}
module.exports = { buildCourse };
