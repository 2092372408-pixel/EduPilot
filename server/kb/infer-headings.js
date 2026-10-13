/**
 * infer-headings.js — 启发式章节识别（对"无 markdown 标题层级"的纯文本流）
 * ------------------------------------------------------------------
 * 背景：PDF / PPT 课件 / 无样式文本经解析后是平铺文本流（无 # 标题），
 *       导致 import 切块时整篇并成 1 章（如 242 块挂一章）。
 * 作用：仅当文档**完全没有任何 ##/### 标题**时介入，按行级模式 + 上下文
 *       规则推断章节，改写为 Markdown 标题（章 ## / 节 ###），供下游
 *       两级目录 / 切块 / 检索使用。
 *
 * 设计原则（宁缺毋滥，防误伤）：
 *   1. 只在"无任何标题"场景触发——已有标题样式的 md/docx 完全不受影响；
 *   2. 章级强信号：显式词（Chapter/第X章/Lesson…）。**无显式章时**才用
 *      "纯大写独行短标题"（课件页大标题）充当章；
 *   3. 有显式章时，其下的页标题/编号行（1.1 / 1 / MATERIAL BALANCE）按节处理；
 *   4. 节编号按"样式类别"计数（1.1 型 / 1 型 / 中文序号型）——类别全文出现
 *      ≥2 才启用该类别（防孤立编号误判）；
 *   5. 所有候选标题后必须跟随实质内容行（排除目录/索引页）。
 */

/** 显式章词（英文） */
const EN_CHAPTER_WORD = /^(chapter|lesson|lecture|unit|module|part|week|session|topic)\b/i;
/** 编号 token：阿拉伯数字 / 罗马数字 / 英文数字词（Chapter Two、Unit 2 有效；UNIT BASICS 无编号不算章） */
const EN_NUM_TOKEN = /^([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/i;

/** 行是否为"显式章标题"：Chapter 2 xxx / Chapter Two / 第三章 变量 / Lesson 3 …（必须带编号） */
function isExplicitChapter(t) {
  const m = /^(chapter|lesson|lecture|unit|module|part|week|session|topic)\s+([^\s:：.\-–—]+)([\s:：.\-–—]*.*)?$/i.exec(t);
  if (m) {
    // 紧跟章词的必须是编号 token（数字/罗马/英文数字词），且总长合理
    if (EN_NUM_TOKEN.test(m[2]) && t.length <= 60) return true;
    return false;
  }
  if (/^第[0-9一二三四五六七八九十百千万零两]+[章篇卷部讲单元课课][^。!?]{0,50}$/.test(t)) return true;
  return false;
}

/** 行是否为"纯大写独行短标题"（课件页大标题，如 MATERIAL BALANCE） */
function isUppercaseTitle(t) {
  if (t.length < 3 || t.length > 70) return false;
  if (/[\u4e00-\u9fa5]/.test(t)) return false;
  if (/[。，；!?？！]/.test(t)) return false;
  // 数字/公式/单位行不是标题（课件表格数据行常以数字开头或含 = + % /）
  if (/^\d/.test(t)) return false;
  if (/[=+%]/.test(t)) return false;
  if (/\/|\||\\/.test(t)) return false;
  const alpha = t.replace(/[^A-Za-z]/g, '');
  if (alpha.length < 3) return false;
  const upper = t.replace(/[^A-Z]/g, '');
  if (upper.length / alpha.length < 0.7) return false;
  if (/^[a-z]/.test(t)) return false;
  if (/[@#^]/.test(t)) return false;
  return true;
}

/** 常见计量单位词/代号开头 → 数据行（如 1 mol、3 kg、5.0 lbm C） */
const UNIT_LEAD = /^(mol|kmol|kg|g|mg|lbm|l|mL|h|min|s|m|m2|m3|kPa|bar|atm|pa|W|kW|MW|J|kJ|MJ|cal|kcal|T|B)\b/i;

/** 节编号样式类别与文本。返回 { style: 'num'|'numdot'|'cn', num, text } 或 null */
function classifySection(t) {
  // 1.1 / 1.1.2 型（小节）
  let m = /^(\d+(?:\.\d+){1,2})\s*[、.．:：\-–—]?\s*([A-Za-z\u4e00-\u9fa5(（"「][^。!?]{1,52})$/.exec(t);
  if (m) {
    const text = m[2];
    // 滤纯单位/短小写串（20.0 cm3 / 1.0 mol 类数据行）
    const unitish = /^[a-z]{1,5}\d?$/.test(text) || /^[A-Za-z]{1,4}\d{1,3}$/.test(text);
    if (!UNIT_LEAD.test(text) && !unitish && !/[=%/\\]/.test(text)) return { style: 'numdot', num: m[1], text };
  }
  // 1 型（单数字编号行：编号须 ≤99 且后接像标题的文字，滤表格数据行）
  m = /^(\d+)\s*[、.．:：\-–—]?\s*([A-Za-z\u4e00-\u9fa5(（"「][^。!?]{1,52})$/.exec(t);
  if (m && parseInt(m[1], 10) <= 99) {
    const text = m[2];
    if (text.length >= 6 && !UNIT_LEAD.test(text) && !/[=%/\\0-9]/.test(text) && !/^[a-z]/.test(text) && !/\d+\s*[a-zA-Z]/.test(text)) {
      return { style: 'num', num: m[1], text };
    }
  }
  // 中文序号：一、引言
  m = /^([一二三四五六七八九十]+)[、.．]\s*([^。!?]{1,50})$/.exec(t);
  if (m) return { style: 'cn', num: m[1], text: m[2] };
  return null;
}

/** 是否像正文内容行 */
function looksLikeContent(line) {
  const t = (line || '').trim();
  if (!t) return false;
  if (t.length >= 40) return true;
  if (/[。．.!?！？]/.test(t)) return true;
  return t.length >= 12;
}

/**
 * 主入口
 * @param {string} markdown 无标题的规范化正文
 * @returns {{ markdown: string, chapterCount: number, sectionCount: number, changed: boolean, warnings: string[] }}
 */
function inferHeadings(markdown) {
  const scanned = [...require('./fenced-lines').fencedLines(markdown || '')];
  const lines = scanned.map((l) => l.line);
  const warnings = [];

  // ① 分类每一行候选：ch(显式章) / cap(全大写) / sec(编号节, 带类别)
  const kind = Array(lines.length).fill(null); // {type:'ch'|'cap'|'sec', ...}
  const styleCount = { num: 0, numdot: 0, cn: 0 };
  const seenTitle = new Set(); // 相同标题文本只立一次（防页眉/重复行产生重复节）
  let chCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (scanned[i].code) continue;
    const t = lines[i].trim();
    if (!t) continue;
    if (isExplicitChapter(t)) { kind[i] = { type: 'ch' }; chCount++; continue; }
    if (isUppercaseTitle(t)) {
      if (!seenTitle.has(t)) { seenTitle.add(t); kind[i] = { type: 'cap' }; }
      continue;
    }
    const s = classifySection(t);
    if (s) {
      const key = s.style + ':' + s.num + ':' + s.text;
      if (!seenTitle.has(key)) { seenTitle.add(key); kind[i] = { type: 'sec', style: s.style, num: s.num, text: s.text }; styleCount[s.style]++; }
    }
  }

  // ② 去噪：候选与下一候选之间必须夹有文本（标题后跟正文/副题/小节）；
  //    目录/索引页的特征是标题连续紧排、夹层 0 行 → 直接移除
  const candidates = kind.slice();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!kind[i]) continue;
    let nxt = -1;
    for (let j = i + 1; j < lines.length; j++) { if (candidates[j]) { nxt = j; break; } }
    const end = nxt >= 0 ? nxt : lines.length;
    let has = false;
    for (let j = i + 1; j < end && j < i + 400; j++) {
      const tt = lines[j].trim();
      if (tt && tt.length >= 3) { has = true; break; } // 副题(Heat)或正文都算
    }
    // 章后直接跟有正文的小节也有效；逆序检查确保子节已通过正文校验。
    const child = nxt >= 0 && kind[nxt];
    const hasChild = kind[i].type === 'ch' && child && (child.type === 'cap'
      || (child.type === 'sec' && styleCount[child.style] >= 2));
    if (!has && !hasChild) kind[i] = null;
  }

  // ③ 章/节定级
  //   - 有显式章：显式章 = 章 ##；章内 全大写页标题 / 编号节（类别计数≥2） = 节 ###
  //   - 无显式章：全大写标题充当章 ##（课件只有页标题时的粗分）；
  //     编号节若类别计数≥2 且位于某全大写章之下 → 节
  //   - 编号节类别计数 < 2 → 不启用（保留原文）
  const hasExplicitChapter = kind.some((k) => k && k.type === 'ch');
  let chapterCount = 0;
  let sectionCount = 0;
  const out = [];
  let inChapter = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const k = kind[i];
    if (!k) { out.push(raw); continue; }
    const t = raw.trim();
    if (k.type === 'ch') {
      out.push(`## ${t}`); chapterCount++; inChapter = true; continue;
    }
    if (k.type === 'cap') {
      if (hasExplicitChapter) {
        // 显式章语境下：全大写页标题 → 节
        if (inChapter) { out.push(`### ${t}`); sectionCount++; continue; }
        out.push(raw); continue;
      }
      // 无显式章：全大写页标题充当章
      out.push(`## ${t}`); chapterCount++; inChapter = true; continue;
    }
    if (k.type === 'sec') {
      const usable = (styleCount[k.style] || 0) >= 2;
      if (usable && inChapter) {
        out.push(`### ${k.num} ${k.text}`); sectionCount++; continue;
      }
      out.push(raw);
    }
  }

  const newMd = out.join('\n').replace(/\n{3,}/g, '\n\n');
  const changed = chapterCount > 0 && newMd !== markdown && /(^|\n)##\s/m.test(newMd);
  if (changed) {
    warnings.push(
      `文档没有标题样式，已按编号/标题特征启发式识别出 ${chapterCount} 章 / ${sectionCount} 节` +
      '（效果不理想时，建议改用 Word 标题样式或 Markdown 手写 ##/### 章节）'
    );
  }
  return { markdown: newMd, chapterCount, sectionCount, changed, warnings };
}

module.exports = { inferHeadings, isExplicitChapter };
