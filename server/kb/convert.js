/**
 * convert.js — 素材 → 规范化 Markdown 转换器（上传方案 v2 · U1）
 * ------------------------------------------------------------
 * 统一哲学：任何格式 → 一份规范化 Markdown → 复用 import.js 切块管线。
 * 支持格式：.md / .txt 直读；.json 自研扁平化；.docx / .pdf / .pptx → 本地 AnyDoc（失败时回退 MarkItDown）。
 *
 * 规范化规则（与 import.js 切块约定对齐）：
 *   1. import.js 以 "# 标题" 分文档、以 "## 标题" 切块；块挂在 curChapter=null 下会被丢弃
 *      → convert 保证输出「≥1 个 ## 章节」且把文档内所有标题统一压成 ##（连续 # 归并）。
 *   2. 首个一级标题（# ）视为文档标题，从正文剥离（避免覆盖 docTitle 后无章节切分）。
 *   3. 超长行（>300 字符）按中/英文句点软断，避免单行吞块、检索粒度失真。
 *   4. 解析为空（扫描件/加密 PDF/空文档）→ throw，由上层转友好提示。
 *
 * Node API：const { convertToMarkdown } = require('./convert')
 *           const { markdown, docTitle, warnings } = await convertToMarkdown(srcPath)
 * CLI：node server/kb/convert.js <file> [--out out.md]   （调试/单测用）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const EXT_NATIVE = new Set(['.docx', '.pdf', '.pptx']);
const EXT_PY = new Set(['.docx', '.pdf', '.pptx', '.doc', '.ppt']); // 兼容解析器
const EXT_MD = new Set(['.md', '.markdown', '.txt']);
const MAX_LINE = 300; // 超长行软断阈值
const ANYDOC_SCRIPT = path.join(__dirname, 'anydoc_convert.js');

/** 原生解析器放在子进程运行，避免损坏的文件拖垮 HTTP 服务。 */
function runAnyDoc(srcPath, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ANYDOC_SCRIPT, srcPath], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const stdout = [];
    let size = 0, stderr = '', done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* ignore */ }
      finish(new Error(`AnyDoc 转换超时（>${timeoutMs / 1000}s）`));
    }, timeoutMs);
    child.stdout.on('data', (data) => {
      size += data.length;
      if (size > 32 * 1024 * 1024) {
        try { child.kill(); } catch (_) { /* ignore */ }
        finish(new Error('AnyDoc 解析内容过大'));
      } else {
        stdout.push(data);
      }
    });
    child.stderr.on('data', (data) => { if (stderr.length < 2000) stderr += data.toString('utf8'); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code !== 0) finish(new Error(`AnyDoc 转换失败：${stderr.trim().slice(0, 200) || `code=${code}`}`));
      else finish(null, Buffer.concat(stdout).toString('utf8'));
    });
  });
}

/* ---------------- Python 解释器定位（统一走 server/python.js：PYTHON_BIN → 项目 venv → PATH） ---------------- */

const { resolvePython } = require('../python');

const CONVERT_PY = path.join(__dirname, 'markitdown_convert.py');

/** spawn Python 执行 markitdown_convert.py，返回 stdout（超时/错误 throw） */
function runMarkItDown(srcPath, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const py = resolvePython();
    const child = spawn(py, ['-I', '-X', 'utf8', CONVERT_PY, srcPath], {
      env: { ...process.env, PYTHONPATH: '', HOME: os.tmpdir() },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      reject(new Error(`MarkItDown 转换超时（>${timeoutMs / 1000}s）`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { if (stdout.length < 2_000_000) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (stderr.length < 200_000) stderr += d.toString('utf8'); });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const hint = stderr.split('\n').filter(Boolean).slice(-3).join(' | ');
        reject(new Error(`MarkItDown 转换失败(code=${code})${hint ? '：' + hint : ''}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/* ---------------- JSON 扁平化（键路径 = 标题，数组 = 列表） ---------------- */

/** 深对象 → 结构化 Markdown 行数组（嵌套对象 → 子标题，路径可读） */
function flattenJsonToLines(obj, keyPath, depth, out) {
  const pad = (d) => '';
  const isPlain = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

  const pushKeyValues = (o) => {
    const entries = Object.entries(o);
    for (const [k, v] of entries) {
      if (isPlain(v)) {
        const s = v === null ? '' : String(v);
        out.push(`- **${k}**：${s.replace(/\s*\n\s*/g, ' ').trim() || '（空）'}`);
      } else if (Array.isArray(v)) {
        if (v.every(isPlain)) {
          out.push(`- **${k}**：${v.map((x) => (x === null ? '' : String(x))).join('、') || '（空数组）'}`);
        } else {
          // 对象数组 → 逐元素递归（元素键 → "N. 键" 便于阅读）
          v.forEach((el, i) => {
            if (isPlain(el)) { out.push(`- **${k}[${i}]**：${el}`); return; }
            if (Array.isArray(el)) { flattenJsonToLines(el, [...keyPath, k, String(i)], depth + 1, out); return; }
            if (el && typeof el === 'object') {
              if (depth >= 4) { // 过深：拍平为行
                out.push(`- **${k}[${i}]**：${JSON.stringify(el).slice(0, 200)}`);
                return;
              }
              out.push(`## ${k} ${i + 1}`);
              pushKeyValues(el);
            }
          });
        }
      } else if (v && typeof v === 'object') {
        if (depth >= 4) {
          out.push(`- **${k}**：${JSON.stringify(v).slice(0, 200)}`);
        } else {
          out.push(`## ${k}`);
          flattenJsonToLines(v, [...keyPath, k], depth + 1, out);
        }
      }
    }
  };

  if (Array.isArray(obj)) {
    if (obj.every(isPlain)) {
      obj.forEach((x, i) => out.push(`${i + 1}. ${x === null ? '' : String(x)}`));
    } else {
      obj.forEach((el, i) => {
        if (isPlain(el)) { out.push(`${i + 1}. ${el}`); return; }
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          out.push(`## 条目 ${i + 1}`);
          pushKeyValues(el);
        } else {
          flattenJsonToLines(el, [...keyPath, String(i)], depth + 1, out);
        }
      });
    }
  } else if (obj && typeof obj === 'object') {
    pushKeyValues(obj);
  } else {
    out.push(String(obj));
  }
}

function jsonToMarkdown(rawText) {
  let obj;
  try { obj = JSON.parse(rawText); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
  const lines = [];
  flattenJsonToLines(obj, [], 0, lines);
  let md = lines.join('\n');
  // 无任何 ## 章节（纯标量列表）→ 补一层章节标题，保证 import 不丢内容
  if (!/^## /m.test(md)) md = '## 数据内容\n\n' + md;
  return md;
}

/* ---------------- 规范化 Markdown ---------------- */

/**
 * 标题层级规范化（与 import.js 两级约定对齐：章=##，节=###）
 * ------------------------------------------------------------
 * 目标：保留素材的「章 → 节」两级结构，不再像旧版把全部标题压平成 ##（层级丢失）。
 * 规则：
 *   1. 首行若为单个 `# 书题`（全文唯一一级标题，且其后是 ## 章节）→ 视为书名，剥离为 docTitle；
 *      否则 `# ` 也按章级保留（多章并列或多级素材不能丢章）。
 *   2. `# ` / `## ` → 统一为章级 `## `（MarkItDown 中 Heading1→#、Heading2→##；归一避免"章"和"节"层级错位）。
 *   3. `### ` → 保留为节级 `### `（import.js 的 section）。
 *   4. `#### `+ 更深标题 → 降为节内加粗段落（不建第三级，内容不丢）。
 *   5. 连续同义标题（# 与 ## 混用表示同一级）不重复铺开——见实现细节。
 */
function normalizeHeadings(raw, fallbackTitle) {
  const lines = [...require('./fenced-lines').fencedLines(raw)];
  const heads = []; // { level, text } 全部标题，先扫描再定层级
  for (const { line, code } of lines) {
    if (code) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const text = m[2].trim();
      if (text) heads.push({ level: m[1].length, text });
    }
  }

  let docTitle = fallbackTitle;

  // 书题判定：恰有 1 个一级标题 且 其后存在二级标题（##）→ 该 # 是书名/大标题
  const lvl1 = heads.filter((h) => h.level === 1);
  const hasL2 = heads.some((h) => h.level === 2);
  const treatFirstAsTitle = lvl1.length === 1 && hasL2 && heads[0].level === 1
    && !require('./infer-headings').isExplicitChapter(heads[0].text);

  // 决定映射：章源级别 = 素材中最浅的非书题级别；节源级别 = 章源级别 + 1
  const sourceLevels = heads
    .filter((h) => !(treatFirstAsTitle && h === heads[0]))
    .map((h) => h.level);
  const chapterSrc = sourceLevels.length ? Math.min(...sourceLevels) : null;
  const sectionSrc = chapterSrc ? chapterSrc + 1 : null;

  const out = [];
  let seen = 0;
  for (const { line, code } of lines) {
    if (code) { out.push(line); continue; }
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const level = m[1].length;
      const text = m[2].trim();
      if (!text) continue;
      // 书题：剥离
      if (treatFirstAsTitle && seen === 0 && level === 1 && heads[0].text === text) {
        docTitle = text;
        seen++;
        continue;
      }
      // 章级（与 chapterSrc 同级或更浅——更浅说明素材用 # 章节、## 节，或 ### 起步的教材）
      if (chapterSrc !== null && level <= chapterSrc) {
        out.push(`## ${text}`);
        seen++;
        continue;
      }
      // 节级（chapterSrc+1）
      if (sectionSrc !== null && level === sectionSrc) {
        out.push(`### ${text}`);
        seen++;
        continue;
      }
      // 更深标题 → 节内加粗段落（避免三级结构，内容保留可检索）
      out.push(`**${text}**`);
      seen++;
      continue;
    }
    out.push(line);
  }
  return { docTitle, body: out.join('\n'), hasHeadings: sourceLevels.length > 0 };
}

/**
 * 超长行按句子边界软断（中文句号/问叹号/英文句点+空格），防单行吞块。
 * 注意：
 *  · 原先 `for (const p of parts)` 内对 p 重新赋值 → 抛 "Assignment to constant variable"，
 *    导致任何超过 MAX_LINE（300）的段落都会让上传直接失败（中文教材极常见）。改用 let。
 *  · 代码块（```…```）内的行**不软断**：断开会破坏代码缩进与语法。
 */
function softWrapLongLines(text) {
  const out = [];
  for (const { line, code } of require('./fenced-lines').fencedLines(text)) {
    if (code || line.length <= MAX_LINE || line.startsWith('|')) {
      out.push(line);
      continue;
    }
    const parts = line.split(/(?<=[。！？!?\.])(?=\s|$)/g).filter(Boolean);
    let rebuilt = '';
    for (let p of parts) {
      if ((rebuilt + p).length <= MAX_LINE) { rebuilt += p; continue; }
      if (rebuilt) { out.push(rebuilt); rebuilt = ''; }
      // 单句仍超长 → 硬截
      while (p.length > MAX_LINE) { out.push(p.slice(0, MAX_LINE)); p = p.slice(MAX_LINE); }
      rebuilt = p;
    }
    if (rebuilt.trim()) out.push(rebuilt);
  }
  return out.join('\n');
}

/** 清理：去 BOM、\r、合并多余空行、去仅有空白/记号的行 */
function cleanup(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, arr) => !(l.trim() === '' && (i === 0 || arr[i - 1].trim() === '')))
    .join('\n')
    .trim();
}

/**
 * 转换入口：任意支持格式 → 规范化 Markdown
 * @param {string} srcPath 源文件（注意：临时文件若以 courseId 命名，无 H1 时标题会带噪音 → 传 opts.fallbackTitle）
 * @param {{ fallbackTitle?: string }} [opts]
 * @returns {{ markdown: string, docTitle: string, warnings: string[] }}
 */
async function convertToMarkdown(srcPath, opts = {}) {
  const ext = path.extname(srcPath).toLowerCase();
  // A permissive fallback must not turn renamed plain text into a valid PDF.
  if (ext === '.pdf') {
    const data = fs.readFileSync(srcPath);
    if (!/^%PDF-1\.[0-9]|^%PDF-2\.0/.test(data.subarray(0, 16).toString('ascii'))
      || !data.subarray(-4096).includes(Buffer.from('%%EOF'))) {
      throw new Error('PDF 文件无效或不完整，请上传有效的文字版 PDF');
    }
  }
  // fallbackTitle 优先用调用方给的真实文档名（如原文件名）；默认才退回源文件名
  const fallbackTitle = (opts.fallbackTitle && String(opts.fallbackTitle).trim())
    || path.basename(srcPath, path.extname(srcPath)).replace(/[_-]+/g, ' ');
  const warnings = [];

  let raw;
  if (EXT_MD.has(ext)) {
    raw = fs.readFileSync(srcPath, 'utf8');
  } else if (ext === '.json') {
    raw = jsonToMarkdown(fs.readFileSync(srcPath, 'utf8'));
    warnings.push('JSON 已按“键=条目 / 嵌套=章节”扁平化，层级信息保留在标题中');
  } else if (EXT_NATIVE.has(ext)) {
    try {
      raw = await runAnyDoc(srcPath);
      if (!raw || !raw.trim()) throw new Error('解析内容为空');
    } catch (e) {
      console.warn('[convert] AnyDoc 解析失败，尝试 MarkItDown:', e.message);
      try {
        raw = await runMarkItDown(srcPath);
      } catch (fallbackError) {
        throw new Error(`本地解析失败（${e.message}）；兼容解析失败（${fallbackError.message}）`);
      }
      warnings.push('已使用兼容解析器处理该文档');
    }
    if (!raw || !raw.trim()) {
      throw new Error('文档解析为空：可能是扫描版 PDF（无文字层）或加密文档，请改用文字版后重试');
    }
  } else if (EXT_PY.has(ext)) {
    if (ext === '.doc' || ext === '.ppt') {
      warnings.push(`${ext} 为旧版格式，MarkItDown 仅支持新格式（docx/pptx），请另存为后再上传`);
    }
    raw = await runMarkItDown(srcPath);
    if (!raw || !raw.trim()) {
      throw new Error('文档解析为空：可能是扫描版 PDF（无文字层）或加密文档，请改用文字版后重试');
    }
  } else {
    throw new Error(`不支持的格式：${ext}（支持 .md/.txt/.json/.docx/.pdf/.pptx）`);
  }

  if (!raw.trim()) throw new Error('文件内容为空');
  if (opts.onProgress) opts.onProgress({ stage: 'structuring' });

  // PDF 的字体大小并不等同标题样式；AnyDoc 偶尔把整句正文标为标题，
  // 而标题行本身不会进入 import.js 的内容块。
  if (ext === '.pdf') raw = raw.replace(/^#{1,6} (.{30,}[。.])$/gm, '$1');

  // 入库前剥离不可见/控制字符（零宽、双向控制、Unicode 标签区）：
  // 上传材料是不可信来源，隐藏字符是间接提示注入的常用载体，在索引前就清掉最彻底。
  const { stripInvisible } = require('../agent/sanitize');
  const rawClean = stripInvisible(raw);
  if (rawClean.length !== raw.length) warnings.push(`已清除 ${raw.length - rawClean.length} 个不可见字符（零宽/控制符）`);

  const cleaned = cleanup(rawClean);
  const { docTitle, body, hasHeadings } = normalizeHeadings(cleaned, fallbackTitle);
  let structured = hasHeadings;
  let markdown = softWrapLongLines(body).trim();

  // 文档本身没有一级标题（#）→ docTitle 只是文件名级兜底，提示用户可自定义课程名
  if (!/^#\s+\S/m.test(cleaned)) {
    warnings.push('文档未识别到一级标题，课程名/章名将采用文件名');
  }

  if (!markdown) throw new Error('规范化后无有效内容');

  // 启发式章节识别：全文无任何 ##/### 标题（纯文本流：PDF/PPT 课件/无样式文本）且正文足够长时，
  // 按编号/标题特征推断章(##)/节(###)——让这类文件也能分出目录（已有标题的 md/docx 不受影响）
  if (!structured) {
    const { inferHeadings, isExplicitChapter } = require('./infer-headings');
    const textLines = [...require('./fenced-lines').fencedLines(markdown)]
      .filter((l) => !l.code && l.line.trim()).map((l) => l.line.trim());
    if (textLines.length >= 10 || textLines.some(isExplicitChapter)) {
      try {
        const inferred = inferHeadings(markdown);
        if (inferred.changed) {
          structured = true;
          markdown = inferred.markdown;
          // 前置正文保护：infer 使文档出现了第一个标题；若它之前还有封面/页眉正文
          // （无章归属，import 会丢弃）→ 包一层文件级章（标题=文件名/书题）
          const firstHead = markdown.search(/(^|\n)#{1,3}\s/m);
          if (firstHead > 0 && markdown.slice(0, firstHead).trim()) {
            markdown = `## ${docTitle}\n\n${markdown.trim()}`;
            inferred.chapterCount += 1;
          }
          warnings.push(`文档没有标题样式，已按编号/标题特征启发式识别出 ${inferred.chapterCount} 章 / ${inferred.sectionCount} 节（效果不理想时，建议改用 Word 标题样式或 Markdown 手写 ##/### 章节）`);
        }
      } catch (e) {
        console.warn('[convert] 启发式章节识别失败（忽略）:', e.message);
      }
    }
  }

  if (!structured) {
    // 兜底：仍无章节/小节 → 整体包一层（原样内容，章节=标题）
    return { markdown: `## ${docTitle}\n\n${markdown}`, docTitle, warnings };
  }
  return { markdown, docTitle, warnings };
}

/* ---------------- CLI（单测/调试） ---------------- */
if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('用法：node server/kb/convert.js <file> [--out out.md]'); process.exit(1); }
  const outIdx = process.argv.indexOf('--out');
  convertToMarkdown(file)
    .then(({ markdown, docTitle, warnings }) => {
      console.log(`# ${docTitle}\n`);
      if (warnings.length) console.log('<!-- ' + warnings.join('；') + ' -->\n');
      console.log(markdown);
      if (outIdx > -1 && process.argv[outIdx + 1]) {
        fs.writeFileSync(process.argv[outIdx + 1], `# ${docTitle}\n\n` + markdown, 'utf8');
        console.error(`\n（已写入 ${process.argv[outIdx + 1]}）`);
      }
    })
    .catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
}

module.exports = { convertToMarkdown, EXT_MD, EXT_PY };
