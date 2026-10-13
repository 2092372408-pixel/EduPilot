/* 主对话与做题助手共用的轻量 Markdown 渲染；Node 测试直接复用。 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.EduMarkdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/**
 * 列表项识别与拆解。
 * 有序：`1.` `1)` `1、` `1）`；编号后允许无空格（中文常写「1、内容」「1.内容」），
 *       但**点号/括号后紧跟数字不算列表**（避免把 `1.5 倍`、版本号 `3.13` 误判成列表项）。
 * 无序：`-` `*` `•`（后需空格，避免把 `*斜体*` 当列表）。
 */
const ORDERED_ITEM_RE = /^(\s*)\d+(?:[.、)）])(?:\s+|(?=\D|$))(.*)$/;
const UNORDERED_ITEM_RE = /^(\s*)[-*•]\s+(.*)$/;
function matchListItem(s) {
  const str = String(s);
  const o = str.match(ORDERED_ITEM_RE);
  if (o) return { indent: o[1].replace(/\t/g, '  ').length, ordered: true, text: o[2] };
  const u = str.match(UNORDERED_ITEM_RE);
  if (u) return { indent: u[1].replace(/\t/g, '  ').length, ordered: false, text: u[2] };
  return null;
}
function isListItem(s) { return matchListItem(s) !== null; }
/** 行缩进宽度（Tab 记 2 空格；仅用于比较"更深/同级"） */
function listIndent(s) {
  return String(s).match(/^\s*/)[0].replace(/\t/g, '  ').length;
}

/** 行内语法：粗体/斜体/行内代码/链接（输入已 HTML 转义） */
function inlineMarkdown(s) {
  // 一次匹配链接/行内代码，避免后续替换改写生成的 HTML 属性或代码内容。
  const emphasis = (value) => value
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const token = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let html = '', from = 0;
  for (const match of s.matchAll(token)) {
    html += emphasis(s.slice(from, match.index));
    if (match[1] !== undefined) html += `<code>${match[1]}</code>`;
    else {
      const url = match[3].trim();
      const safe = /^(https?:\/\/|mailto:)/i.test(url) || /^\/(?![\/\\])/.test(url) || url.startsWith('#');
      html += safe
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${emphasis(match[2])}</a>`
        : emphasis(match[2]);
    }
    from = match.index + match[0].length;
  }
  return html + emphasis(s.slice(from));
}
/** 逐行渲染：表格/代码块/标题/列表/段落，块级结构正确不串行 */
function renderMarkdown(text) {
  const lines = escapeHtml(text).split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1) 代码块 ```lang ... ```
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // 跳过结束 ```
      out.push(`<pre class="code-block">${code.join('\n')}</pre>`);
      continue;
    }

    // 2) 表格：表头行 + 分隔行（|---|）+ 数据行
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const header = cells(line);
      const aligns = lines[i + 1].split('|').map((c) => c.trim()).filter((c) => c !== '').map((c) => {
        const left = c.startsWith(':'); const right = c.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      const alignStyle = (a) => (a ? ` style="text-align:${a}"` : '');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      let html = '<table><thead><tr>';
      header.forEach((h, idx) => { html += `<th${alignStyle(aligns[idx])}>${inlineMarkdown(h)}</th>`; });
      html += '</tr></thead><tbody>';
      rows.forEach((r) => {
        html += '<tr>';
        header.forEach((_, idx) => { html += `<td${alignStyle(aligns[idx])}>${inlineMarkdown(r[idx] || '')}</td>`; });
        html += '</tr>';
      });
      html += '</tbody></table>';
      out.push(`<div class="table-scroll" tabindex="0" role="region" aria-label="表格">${html}</div>`);
      continue;
    }

    // 3) 标题 ## / ### / ####（h3~h5，避免与页面 h1/h2 冲突）
    const h = line.match(/^(#{2,4})\s+(.+)$/);
    if (h) { out.push(`<h${h[1].length + 1}>${inlineMarkdown(h[2])}</h${h[1].length + 1}>`); i++; continue; }

    // 4) 列表：**整块**收集后渲染成一个 ol/ul
    //    根因（曾导致"序号全是 1"）：旧实现只合并「连续且同标记」的行，一旦遇到
    //    ① 项之间有空行、② 缩进的续行（如「来源：…」）、③ 更深一级的子列表，
    //    列表就被截断成多个独立的 <ol>；浏览器对每个 <ol> 都从 1 重新编号，
    //    于是整段结果全都显示 1。这里改为按"列表块"整体收集：
    //    同级（允许空行间隔，且标记类型不变）→ 同一列表项序列；
    //    更深缩进 → 归属上一项（子列表或续行）；同级但标记类型变了 → 结束本列表。
    const first = matchListItem(line);
    if (first) {
      const base = first.indent;
      const ordered = first.ordered;
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) {
          // 空行：可能是项间分隔。向后看一行，若仍属本列表则继续，否则结束。
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j >= lines.length) break;
          const nxt = matchListItem(lines[j]);
          if (!nxt || listIndent(lines[j]) > base + 1) break; // 深缩进的块不跨空行归属
          i = j;
          continue;
        }
        const it = matchListItem(cur);
        const ind = it ? it.indent : listIndent(cur);
        if (it && ind <= base + 1) {
          if (it.ordered !== ordered) break; // 同级换了标记类型 → 另起一个列表
          items.push({ text: it.text, subs: [] });
          i++;
          continue;
        }
        if (items.length && ind > base + 1) {
          const last = items[items.length - 1];
          if (it) last.subs.push({ ordered: it.ordered, text: it.text }); // 子列表
          else last.text += (last.text ? ' ' : '') + cur.trim();          // 续行归入上一项
          i++;
          continue;
        }
        break; // 回到顶层且不是本列表的项 → 本列表结束
      }
      const renderItems = (arr, tag) => `<${tag}>` + arr.map((it) => {
        let inner = inlineMarkdown(it.text);
        if (it.subs && it.subs.length) inner += renderItems(it.subs, it.subs.some((x) => x.ordered) ? 'ol' : 'ul');
        return `<li>${inner}</li>`;
      }).join('') + `</${tag}>`;
      out.push(renderItems(items, ordered ? 'ol' : 'ul'));
      continue;
    }

    // 5) 空行 → 段落分隔
    if (!line.trim()) { i++; continue; }

    // 6) 普通段落
    out.push(`<p>${inlineMarkdown(line)}</p>`);
    i++;
  }
  return out.join('\n');
}


return { escapeHtml, renderMarkdown };
});
