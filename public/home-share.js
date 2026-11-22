/* Render the selected learning records as a portable, local PNG card. */
(function () {
  'use strict';
  const projectUrl = 'https://github.com/2092372408-pixel/EduPilot';
  const list = value => Array.isArray(value) ? value : [];
  const cleanText = (value, length = 180) => typeof value === 'string'
    ? [...value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, length).join('') : '';
  const count = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

  function buildSnapshot(data, { courseIds = [], showName = true, lang = 'zh' } = {}) {
    const catalog = new Map();
    for (const course of list(data?.courses)) if (course && typeof course.id === 'string' && !catalog.has(course.id)) catalog.set(course.id, course);
    const ids = [...new Set(list(courseIds))].filter(id => catalog.has(id)).slice(0, 4);
    const courses = ids.map(id => {
      const course = catalog.get(id), totalTopics = count(course.totalTopics);
      const masteredTopics = Math.min(totalTopics, count(course.masteredTopics));
      const studiedTopics = Math.min(totalTopics, Math.max(masteredTopics, count(course.studiedTopics)));
      return { id, title: cleanText(course.title), totalTopics, studiedTopics, masteredTopics,
        progressPercent: totalTopics ? Math.round(masteredTopics * 100 / totalTopics) : 0 };
    });
    const selected = new Map(courses.map(course => [course.id, course]));
    const skills = [], domains = [], seenSkills = new Set(), seenDomains = new Set();
    const selectedDomains = list(data?.domains).filter(domain => domain && selected.has(domain.courseId));
    for (const domain of selectedDomains) {
      for (const skill of list(domain.skills)) {
        if (!skill || skill.mastered !== true || typeof skill.kpId !== 'string' || !skill.kpId || !cleanText(skill.title)) continue;
        const key = JSON.stringify([domain.courseId, skill.kpId]);
        if (seenSkills.has(key)) continue;
        seenSkills.add(key);
        if (skills.length < 8) skills.push({ courseId: domain.courseId, kpId: skill.kpId,
          title: cleanText(skill.title), courseTitle: selected.get(domain.courseId).title });
      }
    }
    for (const domain of selectedDomains) {
      if (domains.length >= Math.min(6, 8 - skills.length)) break;
      const totalTopics = count(domain.totalTopics), studiedTopics = Math.min(totalTopics, count(domain.studiedTopics));
      if (!studiedTopics || count(domain.masteredTopics) >= totalTopics || !cleanText(domain.title) || typeof domain.id !== 'string') continue;
      const key = JSON.stringify([domain.courseId, domain.id]);
      if (seenDomains.has(key)) continue;
      seenDomains.add(key);
      domains.push({ courseId: domain.courseId, id: domain.id, title: cleanText(domain.title),
        courseTitle: selected.get(domain.courseId).title, totalTopics, studiedTopics });
    }
    const summary = courses.reduce((totals, course) => {
      for (const key of ['totalTopics', 'studiedTopics', 'masteredTopics']) totals[key] += course[key];
      return totals;
    }, { courses: courses.length, totalTopics: 0, studiedTopics: 0, masteredTopics: 0 });
    const date = new Date(typeof data?.generatedAt === 'string' ? data.generatedAt : '');
    const snapshot = { version: 1, lang: lang === 'en' ? 'en' : 'zh',
      generatedAt: Number.isFinite(date.getTime()) ? date.toISOString() : '', projectUrl, summary, courses, skills, domains };
    const nickname = cleanText(data?.profile?.nickname, 20);
    if (showName && nickname) snapshot.nickname = nickname;
    return snapshot;
  }

  const words = {
    zh: {
      eyebrow: '我的学习主页', title: '我的学习足迹', named: name => name + '的学习足迹',
      subtitle: '把学过的知识，变成自己的能力。', courses: '精选课程', studied: '已学知识点', mastered: '复习通过',
      courseSection: '持续前进的课程', progress: (done, total) => `已掌握 ${done} / ${total} 个知识点`,
      skillSection: '通过复习验证的知识', domainSection: '学习中的领域',
      emptyCourses: '从一门感兴趣的课程开始。', emptySkills: '每一次练习，都是下一步的起点。',
      footer: '把教材变成课程，把学习积累成成果。', scan: '扫码，一起开始学习',
      imageError: '分享图片资源加载失败，请重试。', canvasError: '暂时无法生成分享图片，请重试。',
    },
    en: {
      eyebrow: 'MY LEARNING HOME', title: 'My learning journey', named: name => name + '\u2019s learning journey',
      subtitle: 'From materials to practice. From practice to progress.', courses: 'Selected courses', studied: 'Concepts studied', mastered: 'Review checks passed',
      courseSection: 'Learning in progress', progress: (done, total) => `${done} / ${total} concepts mastered`,
      skillSection: 'Knowledge checked in review', domainSection: 'Areas I\u2019m exploring',
      emptyCourses: 'Start with a course that interests you.', emptySkills: 'Every practice session is a step forward.',
      footer: 'Turn your materials into courses. Make progress visible.', scan: 'Scan to start learning',
      imageError: 'The card images could not load. Please retry.', canvasError: 'The learning card could not be created. Please retry.',
    },
  };
  const assets = new Map();
  function imageAsset(path, message) {
    if (!assets.has(path)) assets.set(path, new Promise((resolve, reject) => {
      const image = new Image();
      let settled = false;
      const failed = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); assets.delete(path); reject(new Error(message));
      };
      const timer = setTimeout(failed, 8000);
      image.onload = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(image); };
      image.onerror = failed;
      image.src = new URL(path, location.origin).href;
    }));
    return assets.get(path);
  }
  const fontFamily = '"Inter", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
  const segments = value => typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(item => item.segment) : [...value];
  function font(context, size, weight = 400) { context.font = `${weight} ${size}px ${fontFamily}`; }
  function fit(context, value, width) {
    if (context.measureText(value).width <= width) return value;
    const parts = segments(value);
    while (parts.length && context.measureText(parts.join('') + '\u2026').width > width) parts.pop();
    return parts.join('') + '\u2026';
  }
  function wrap(context, value, width, limit = 2) {
    const characters = segments(value), lines = [];
    let line = '';
    while (characters.length) {
      const next = characters.shift();
      if (line && context.measureText(line + next).width > width) {
        if (lines.length === limit - 1) { lines.push(fit(context, line + next + characters.join(''), width)); return lines; }
        const breakAt = line.lastIndexOf(' ');
        if (breakAt > line.length / 3) {
          lines.push(line.slice(0, breakAt).trimEnd());
          line = line.slice(breakAt + 1) + next;
        } else { lines.push(line.trimEnd()); line = next.trimStart(); }
      } else line += next;
    }
    if (line || !lines.length) lines.push(line.trimEnd());
    return lines;
  }
  function rounded(context, x, y, width, height, radius, fill, stroke) {
    context.beginPath();
    context.moveTo(x + radius, y); context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius); context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height); context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius); context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y); context.closePath();
    if (fill) { context.fillStyle = fill; context.fill(); }
    if (stroke) { context.strokeStyle = stroke; context.lineWidth = 1; context.stroke(); }
  }

  async function render(snapshot) {
    const text = words[snapshot.lang === 'en' ? 'en' : 'zh'];
    await document.fonts?.ready;
    const [logo, qr] = await Promise.all([
      imageAsset('/logo-mark.png', text.imageError), imageAsset('/project-qr.svg', text.imageError),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    let context = canvas.getContext('2d');
    if (!context) throw new Error(text.canvasError);
    const padding = 64, width = canvas.width - padding * 2;
    font(context, 44, 650);
    const titleLines = wrap(context, snapshot.nickname ? text.named(snapshot.nickname) : text.title, width, 2);
    font(context, 23);
    const subtitleLines = wrap(context, text.subtitle, width, 2);
    const statsY = 182 + titleLines.length * 56 + 16 + subtitleLines.length * 34 + 32;
    const courseY = statsY + 122 + 38;
    const courseEnd = courseY + 48 + (snapshot.courses.length ? snapshot.courses.length * 100 + (snapshot.courses.length - 1) * 12 : 84);
    const tagRows = items => Math.ceil(items.length / 3);
    const sectionHeight = items => items.length ? 48 + tagRows(items) * 46 + (tagRows(items) - 1) * 10 + 24 : 0;
    const skillsHeight = sectionHeight(snapshot.skills) + sectionHeight(snapshot.domains);
    const contentEnd = courseEnd + 32 + (skillsHeight || 74);
    canvas.height = Math.max(1100, contentEnd + 238);
    context = canvas.getContext('2d');
    context.textBaseline = 'top';
    const color = { ink: '#1c3327', green: '#2f5a3e', muted: '#718075', pale: '#f0f4ed', line: '#dfe6dc', white: '#ffffff' };
    context.fillStyle = color.white; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(logo, padding, 52, 48, 48);
    font(context, 28, 650); context.fillStyle = color.ink; context.fillText('EduPilot', padding + 62, 60);
    const date = new Date(snapshot.generatedAt);
    const dateLabel = Number.isFinite(date.getTime()) ? date.toLocaleDateString(snapshot.lang === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    font(context, 19); context.fillStyle = color.muted; context.textAlign = 'right'; context.fillText(dateLabel, canvas.width - padding, 66); context.textAlign = 'left';
    context.fillStyle = color.line; context.fillRect(padding, 127, width, 1);
    font(context, 17, 600); context.fillStyle = color.muted; context.fillText(text.eyebrow, padding, 151);
    font(context, 44, 650); context.fillStyle = color.ink;
    titleLines.forEach((line, index) => context.fillText(line, padding, 182 + index * 56));
    font(context, 23); context.fillStyle = color.muted;
    subtitleLines.forEach((line, index) => context.fillText(line, padding, 182 + titleLines.length * 56 + 16 + index * 34));

    rounded(context, padding, statsY, width, 122, 18, color.pale);
    const stats = [[snapshot.summary.courses, text.courses], [snapshot.summary.studiedTopics, text.studied], [snapshot.summary.masteredTopics, text.mastered]];
    stats.forEach(([number, label], index) => {
      const x = padding + 28 + index * width / 3;
      if (index) { context.fillStyle = color.line; context.fillRect(x - 28, statsY + 26, 1, 70); }
      font(context, 43, 650); context.fillStyle = color.ink; context.fillText(fit(context, String(number), width / 3 - 52), x, statsY + 18);
      font(context, 18); context.fillStyle = color.muted; context.fillText(fit(context, label, width / 3 - 46), x, statsY + 78);
    });

    font(context, 25, 600); context.fillStyle = color.ink; context.fillText(text.courseSection, padding, courseY);
    if (!snapshot.courses.length) {
      font(context, 23); context.fillStyle = color.muted; context.fillText(text.emptyCourses, padding, courseY + 62);
    }
    snapshot.courses.forEach((course, index) => {
      const y = courseY + 48 + index * 112;
      rounded(context, padding, y, width, 100, 14, color.white, color.line);
      font(context, 24, 600); context.fillStyle = color.ink; context.fillText(fit(context, course.title, width - 48), padding + 24, y + 15);
      font(context, 18); context.fillStyle = color.muted; context.fillText(fit(context, text.progress(course.masteredTopics, course.totalTopics), width - 150), padding + 24, y + 50);
      context.textAlign = 'right'; font(context, 18, 600); context.fillStyle = color.green; context.fillText(course.progressPercent + '%', padding + width - 24, y + 50); context.textAlign = 'left';
      rounded(context, padding + 24, y + 80, width - 48, 6, 3, color.pale);
      if (course.progressPercent) rounded(context, padding + 24, y + 80, (width - 48) * course.progressPercent / 100, 6, 3, color.green);
    });

    let sectionY = courseEnd + 32;
    function drawTags(items, title, green) {
      if (!items.length) return;
      font(context, 25, 600); context.fillStyle = color.ink; context.fillText(title, padding, sectionY);
      const gap = 12, column = (width - gap * 2) / 3;
      items.forEach((item, index) => {
        const x = padding + index % 3 * (column + gap), y = sectionY + 48 + Math.floor(index / 3) * 56;
        rounded(context, x, y, column, 46, 12, green ? color.pale : '#f6f7f4', green ? null : color.line);
        font(context, 19, 500); context.fillStyle = green ? color.green : color.muted;
        context.fillText(fit(context, item.title, column - 32), x + 16, y + 11);
      });
      sectionY += sectionHeight(items);
    }
    drawTags(snapshot.skills, text.skillSection, true);
    drawTags(snapshot.domains, text.domainSection, false);
    if (!skillsHeight) { font(context, 23); context.fillStyle = color.muted; context.fillText(text.emptySkills, padding, sectionY + 20); }

    const footerY = canvas.height - 218;
    context.fillStyle = color.pale; context.fillRect(0, footerY, canvas.width, 218);
    font(context, 24, 650); context.fillStyle = color.ink; context.fillText('EduPilot', padding, footerY + 32);
    font(context, 20); context.fillStyle = color.muted;
    wrap(context, text.footer, width - 200, 2).forEach((line, index) => context.fillText(line, padding, footerY + 72 + index * 28));
    font(context, 18, 500); context.fillStyle = color.green; context.fillText(projectUrl, padding, footerY + 143);
    context.drawImage(qr, canvas.width - padding - 164, footerY + 14, 164, 164);
    font(context, 15); context.fillStyle = color.muted; context.textAlign = 'center'; context.fillText(text.scan, canvas.width - padding - 82, footerY + 187); context.textAlign = 'left';
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(text.canvasError)), 'image/png'));
    const day = Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : 'progress';
    return { canvas, blob, filename: 'EduPilot-learning-' + day + '.png' };
  }

  window.EduHomeShare = { projectUrl, buildSnapshot, render };
})();
