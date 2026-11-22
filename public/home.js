/* Course-wide progress comes from the Python summary; sharing uses a selected snapshot. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const uid = localStorage.getItem('eduowl_uid') || ('learner-' + (crypto.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)));
  localStorage.setItem('eduowl_uid', uid);
  const state = { data: null, fresh: false, filter: 'all', moreSkills: false, loading: false, active: true, revision: 0, controller: null, shareRevision: 0, shareIds: new Set(), shareResult: null, previewUrl: null };
  const words = {
    zh: {
      eyebrow: 'MY LEARNING', title: '学习主页', myHome: '我的学习主页', greeting: '你好，{name}',
      intro: '把教材变成课程，把学习积累成看得见的进步。', openWorkspace: '学习空间',
      share: '分享学习主页', editName: '编辑昵称', overview: '学习概览', activeCourses: '在学课程', studiedTopics: '已学知识点', masteredTopics: '复习通过',
      loading: '正在整理你的学习进度…', retry: '重新加载', loadError: '暂时无法更新学习主页，请重试。', refreshed: '学习主页已更新。',
      courseBusy: '当前对话正在处理中，完成后即可切换课程。',
      startLearning: '开始学习', next: '继续一点点', begin: '从这里开始', continue: '继续学习', openCourse: '打开课程',
      nextTopic: '下一步 · {topic}', allComplete: '这门课的复习已全部通过，随时可以回顾。', materialCourse: '围绕自己的材料提问，逐步建立理解。',
      noCoursesTitle: '从一份教材，开启新的学习', noCoursesNote: '导入自己的资料，或先试一道 Python 诊断题。',
      tryPractice: '做一道 Python 诊断题', tryPracticeNote: '运行、订正，再试一道新题', importMaterials: '带上自己的教材', importNote: '从一份 PDF，开始一门课程',
      myCourses: '我的课程', courseSummary: '{courses} 门课程 · {completed} 门已完成', details: '查看学习报告 ↗',
      allCourses: '全部', inProgress: '学习中', completed: '已完成', notStarted: '待开始', filterCourses: '筛选课程', searchCourses: '搜索课程',
      chapterCount: '{n} 个章节', noChapters: '素材问答', due: '{n} 个待复习', mastery: '已掌握', masteryCount: '已掌握 {n}/{total}',
      courseProgress: '{title}：已掌握 {n}/{total} 个知识点', noMatch: '没有找到符合条件的课程。', clearFilters: '查看全部课程',
      skillDomains: '我的技能领域', skillsNote: '从课程知识点开始，逐步积累自己的能力。', openGraph: '打开知识图谱 ↗',
      mastered: '已掌握', domainLearning: '学习中', skillsEmptyTitle: '你的技能，从下一次练习开始', skillsEmpty: '学习一门课、完成练习，这里会逐步出现你的技能领域。',
      skillsStart: '体验 Python 课程', showMore: '展开更多领域', showLess: '收起领域', extraSkills: '还有 {n} 个已掌握知识点',
      footer: '教材 · 练习 · 进度 · 你的知识网络', project: '项目主页 ↗',
      close: '关闭', nickname: '怎么称呼你？', saveName: '保存昵称', savingName: '正在保存…', nameError: '请输入 1–20 字的昵称。', saveError: '昵称暂时未能保存，请重试。', nameSaved: '昵称已更新。',
      shareTitle: '把进步分享出去', shareNote: '选几门课，生成属于你的学习名片。', selectCourses: '展示课程（最多 4 门）', showNickname: '显示我的昵称',
      shareHint: '图片附带项目地址和二维码，朋友可以由此开始体验。', generating: '正在生成学习名片…', previewAlt: '学习名片预览', systemShare: '系统分享', saveImage: '保存图片',
      selectOne: '请选择至少一门课程。', shareError: '图片暂时未能生成，请重试。', shareLimit: '最多选择 4 门课程。', saved: '图片已准备好保存。', shareSheetTitle: '我的 EduPilot 学习名片', shareText: '和我一起，把教材变成课程，把学习积累成进步。', nativeError: '分享未能完成，可以保存图片后分享。',
    },
    en: {
      eyebrow: 'MY LEARNING', title: 'Learning home', myHome: 'My learning home', greeting: 'Hello, {name}',
      intro: 'Turn your materials into courses. Turn your learning into visible progress.', openWorkspace: 'Workspace',
      share: 'Share learning home', editName: 'Edit name', overview: 'Learning overview', activeCourses: 'Courses in progress', studiedTopics: 'Topics studied', masteredTopics: 'Review checks passed',
      loading: 'Gathering your learning progress…', retry: 'Try again', loadError: 'Your learning home could not be updated. Please try again.', refreshed: 'Learning home updated.',
      courseBusy: 'The current conversation is still running. You can switch courses when it finishes.',
      startLearning: 'Start learning', next: 'PICK UP WHERE YOU LEFT OFF', begin: 'A PLACE TO BEGIN', continue: 'Continue', openCourse: 'Open course',
      nextTopic: 'Up next · {topic}', allComplete: 'All review checks in this course are complete. Come back for a refresher anytime.', materialCourse: 'Explore your own materials and build your understanding.',
      noCoursesTitle: 'Your next course starts with your materials', noCoursesNote: 'Import a document, or try a Python diagnostic exercise.',
      tryPractice: 'Try a Python diagnostic', tryPracticeNote: 'Run, refine, then try a fresh problem', importMaterials: 'Bring your own materials', importNote: 'Start a course from a PDF',
      myCourses: 'My courses', courseSummary: '{courses} courses · {completed} completed', details: 'Learning report ↗',
      allCourses: 'All', inProgress: 'In progress', completed: 'Completed', notStarted: 'Not started', filterCourses: 'Filter courses', searchCourses: 'Find a course',
      chapterCount: '{n} chapters', noChapters: 'Material Q&A', due: '{n} due for review', mastery: 'Mastered', masteryCount: '{n}/{total} mastered',
      courseProgress: '{title}: {n} of {total} topics mastered', noMatch: 'No courses match this search.', clearFilters: 'View all courses',
      skillDomains: 'My skill areas', skillsNote: 'Build your skills one course topic at a time.', openGraph: 'Knowledge graph ↗',
      mastered: 'Mastered', domainLearning: 'In progress', skillsEmptyTitle: 'Your next practice builds your next skill', skillsEmpty: 'Study a course and complete exercises to start seeing your skill areas here.',
      skillsStart: 'Explore the Python course', showMore: 'Show more areas', showLess: 'Show fewer areas', extraSkills: '{n} more mastered topics',
      footer: 'Materials · Practice · Progress · Your knowledge network', project: 'Project home ↗',
      close: 'Close', nickname: 'What should we call you?', saveName: 'Save name', savingName: 'Saving…', nameError: 'Enter a name of 1–20 characters.', saveError: 'Your name could not be saved. Please try again.', nameSaved: 'Name updated.',
      shareTitle: 'Share how far you have come', shareNote: 'Pick a few courses for your learning card.', selectCourses: 'Courses to show (up to 4)', showNickname: 'Show my name',
      shareHint: 'The image includes a project link and QR code so friends can try EduPilot.', generating: 'Creating your learning card…', previewAlt: 'Learning card preview', systemShare: 'Share', saveImage: 'Save image',
      selectOne: 'Select at least one course.', shareError: 'The image could not be created. Please try again.', shareLimit: 'Choose up to 4 courses.', saved: 'Your image is ready to save.', shareSheetTitle: 'My EduPilot learning card', shareText: 'Turn your materials into courses. Build visible learning progress with me.', nativeError: 'Sharing could not be completed. You can save the image and share it.',
    },
  };
  const language = () => window.eduLanguage?.() === 'en' ? 'en' : 'zh';
  const tr = (key, args = {}) => Object.entries(args).reduce((text, [k, v]) => text.replaceAll('{' + k + '}', String(v)), words[language()][key] || key);
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
  const localHref = href => { const url = new URL(href, location.origin); url.searchParams.set('lang', language()); return url.pathname + url.search; };
  const link = (label, href, className) => { const el = node('a', className, label); el.href = localHref(href); return el; };
  const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  function announce(text) { $('homeAnnouncement').textContent = text; }
  function localize() {
    document.documentElement.lang = language() === 'en' ? 'en' : 'zh-CN';
    document.title = 'EduPilot · ' + tr('title');
    document.querySelectorAll('[data-home]').forEach(el => { el.textContent = tr(el.dataset.home); });
    for (const attr of ['aria', 'alt']) document.querySelectorAll('[data-home-' + attr + ']').forEach(el => el.setAttribute(attr === 'aria' ? 'aria-label' : 'alt', tr(el.getAttribute('data-home-' + attr))));
    $('homeSearch').placeholder = tr('searchCourses');
    $('homeLanguage').textContent = language() === 'en' ? '中文' : 'EN';
    window.applySettings?.();
  }
  async function request(url, options = {}) {
    const response = await (window.eduFetch || fetch)(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw Object.assign(new Error('request_failed'), { status: response.status });
    return data;
  }
  function clearShareResult() {
    state.shareRevision++;
    state.shareResult = null;
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
    $('homeShareImage').hidden = true;
    $('homeShareImage').removeAttribute('src');
    $('homeDownload').disabled = true;
    $('homeNativeShare').disabled = true;
    $('homeShareStatus').textContent = '';
  }
  async function load() {
    if (!state.active) return;
    const revision = ++state.revision;
    state.controller?.abort();
    const controller = new AbortController(); state.controller = controller;
    state.loading = true;
    state.fresh = false;
    $('homeShare').disabled = true;
    $('homeError').hidden = true;
    if ($('homeShareDialog').open) { clearShareResult(); $('homeShareLoading').hidden = false; }
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const url = '/api/learning-home?uid=' + encodeURIComponent(uid) + '&lang=' + language();
      let data;
      try { data = await request(url, { signal: controller.signal }); }
      catch (error) {
        if (error.status !== 409 || controller.signal.aborted) throw error;
        data = await request(url, { signal: controller.signal });
      }
      if (revision !== state.revision || !state.active) return;
      state.data = data;
      state.fresh = true;
      state.loading = false;
      $('homeLoading').hidden = true;
      $('homeContent').hidden = false;
      $('homeShare').disabled = false;
      render();
      if ($('homeShareDialog').open) {
        const existing = new Set(data.courses.map(course => course.id));
        state.shareIds = new Set([...state.shareIds].filter(id => existing.has(id)));
        renderShareChoices();
        await renderShare();
      }
      announce(tr('refreshed'));
    } catch (_) {
      if (revision !== state.revision || !state.active) return;
      $('homeLoading').hidden = true;
      $('homeErrorText').textContent = tr('loadError'); $('homeError').hidden = false;
      if ($('homeShareDialog').open) { $('homeShareLoading').hidden = true; shareError(tr('loadError'), true); }
    } finally {
      clearTimeout(timeout);
      if (revision === state.revision) state.loading = false;
    }
  }
  function render() {
    const data = state.data;
    const name = data.profile?.nickname || '';
    $('homeGreeting').textContent = name ? tr('greeting', { name }) : tr('myHome');
    $('homeAvatar').textContent = [...name][0] || (language() === 'en' ? 'L' : '学');
    $('homeActiveCourses').textContent = number(data.summary.activeCourses);
    $('homeStudied').textContent = number(data.summary.studiedTopics);
    $('homeMastered').textContent = number(data.summary.masteredTopics);
    $('homeCourseSummary').textContent = tr('courseSummary', { courses: data.courses.length, completed: number(data.summary.completedCourses) });
    renderNext(); renderCourses(); renderSkills();
  }
  function renderNext() {
    const courses = state.data.courses;
    const remembered = localStorage.getItem('eduowl_course');
    const selected = courses.find(course => course.id === remembered && course.status === 'learning') || courses.find(course => course.status === 'learning') || courses.find(course => course.id === remembered) || courses[0];
    const content = node('div', 'home-next-text');
    content.append(node('p', 'home-eyebrow', tr(selected?.studiedTopics ? 'next' : 'begin')));
    const title = node('h2', '', selected?.title || tr('noCoursesTitle')); title.id = 'homeNextTitle'; content.append(title);
    const subtitle = selected ? (selected.nextTopic ? tr('nextTopic', { topic: selected.nextTopic.title }) : tr(selected.status === 'completed' ? 'allComplete' : 'materialCourse')) : tr('noCoursesNote');
    content.append(node('p', '', subtitle));
    const action = link(tr(selected ? (selected.studiedTopics ? 'continue' : 'openCourse') : 'importMaterials'), selected?.nextTopic?.href || selected?.href || '/upload.html', 'home-button home-primary');
    $('homeNext').replaceChildren(content, action);
  }
  function progress(course) {
    const wrap = node('div', 'home-course-progress');
    const label = node('div', 'home-progress-meta');
    label.append(node('span', '', tr('mastery')), node('strong', '', number(course.masteredTopics) + '/' + number(course.totalTopics)));
    const bar = node('progress', 'home-progress');
    bar.max = Math.max(1, number(course.totalTopics)); bar.value = number(course.masteredTopics);
    bar.setAttribute('aria-label', tr('courseProgress', { title: course.title, n: number(course.masteredTopics), total: number(course.totalTopics) }));
    wrap.append(label, bar); return wrap;
  }
  function renderCourses() {
    const search = $('homeSearch').value.trim().toLocaleLowerCase();
    const courses = state.data.courses.filter(course => (state.filter === 'all' || course.status === state.filter) && (!search || course.title.toLocaleLowerCase().includes(search)));
    const rows = courses.map(course => {
      const row = link('', course.nextTopic?.href || course.href, 'home-course-row'); row.dataset.courseId = course.id;
      const content = node('div'); content.append(node('h3', '', course.title));
      const meta = node('p', 'home-course-meta');
      meta.append(node('span', '', tr(course.status === 'completed' ? 'completed' : course.status === 'learning' ? 'inProgress' : 'notStarted')));
      meta.append(node('span', '', '·'), node('span', '', course.chapterCount ? tr('chapterCount', { n: course.chapterCount }) : tr('noChapters')));
      if (course.reviewDue) meta.append(node('span', 'home-due', tr('due', { n: course.reviewDue })));
      content.append(meta); row.append(content, progress(course), node('span', 'home-course-arrow', '↗'));
      return row;
    });
    if (!rows.length) {
      const empty = node('div', 'home-empty'); empty.append(node('p', '', tr('noMatch')));
      const reset = node('button', 'home-text-button', tr('clearFilters')); reset.type = 'button';
      reset.addEventListener('click', () => { state.filter = 'all'; $('homeSearch').value = ''; renderFilters(); renderCourses(); }); empty.append(reset); rows.push(empty);
    }
    $('homeCourses').replaceChildren(...rows);
  }
  function renderFilters() { document.querySelectorAll('[data-course-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.courseFilter === state.filter))); }
  function renderSkills() {
    const domains = state.data.domains.filter(domain => domain.studiedTopics > 0 || domain.masteredTopics > 0);
    const displayed = state.moreSkills ? domains : domains.slice(0, 6);
    const cards = displayed.map(domain => {
      const card = node('article', 'home-skill');
      const header = node('div', 'home-skill-top'); const title = node('h3');
      title.append(link(domain.title, '/knowledge-graph.html?course=' + encodeURIComponent(domain.courseId), ''));
      header.append(title, node('span', 'home-skill-status' + (domain.status === 'mastered' ? ' is-mastered' : ''), tr(domain.status === 'mastered' ? 'mastered' : 'domainLearning')));
      const mastery = domain.totalTopics ? Math.round(number(domain.masteredTopics) * 100 / number(domain.totalTopics)) : 0;
      card.append(header, node('p', 'home-skill-source', domain.courseTitle), node('p', 'home-skill-count', tr('masteryCount', { n: domain.masteredTopics, total: domain.totalTopics })));
      const meter = node('div', 'home-skill-progress');
      const fill = node('span'); fill.style.width = mastery + '%'; meter.append(fill); card.append(meter);
      const mastered = domain.skills.filter(skill => skill.mastered);
      if (mastered.length) {
        const tags = node('div', 'home-skill-tags');
        mastered.slice(0, 3).forEach(skill => tags.append(link('✓ ' + skill.title, skill.href, '')));
        card.append(tags);
        if (mastered.length > 3) card.append(node('p', 'home-skill-source', tr('extraSkills', { n: mastered.length - 3 })));
      }
      return card;
    });
    if (!cards.length) {
      const empty = node('div', 'home-empty'); empty.append(node('h3', '', tr('skillsEmptyTitle')), node('p', '', tr('skillsEmpty')), link(tr('skillsStart'), '/?course=python-intro', '')); cards.push(empty);
    }
    $('homeSkills').replaceChildren(...cards);
    $('homeMoreSkills').hidden = domains.length <= 6;
    $('homeMoreSkills').textContent = tr(state.moreSkills ? 'showLess' : 'showMore');
  }
  function shareError(text, retry = false) { $('homeShareError').textContent = text; $('homeShareError').hidden = !text; $('homeShareRetry').hidden = !retry; }
  function renderShareChoices() {
    const rows = state.data.courses.map(course => {
      const label = node('label'); const input = node('input'); input.type = 'checkbox'; input.value = course.id;
      input.checked = state.shareIds.has(course.id); input.disabled = !input.checked && state.shareIds.size >= 4;
      input.addEventListener('change', () => {
        if (input.checked && state.shareIds.size >= 4) { input.checked = false; shareError(tr('shareLimit')); return; }
        if (input.checked) state.shareIds.add(course.id); else state.shareIds.delete(course.id);
        renderShareChoices(); renderShare();
      });
      label.append(input, node('span', '', course.title)); return label;
    });
    $('homeShareCourses').replaceChildren(...rows);
  }
  async function renderShare() {
    clearShareResult(); shareError('');
    if (!state.shareIds.size) { $('homeShareLoading').hidden = true; shareError(tr('selectOne')); return; }
    if (state.loading || !state.data || !$('homeShareDialog').open) return;
    if (!state.fresh) { $('homeShareLoading').hidden = true; shareError(tr('loadError'), true); return; }
    $('homeShareLoading').hidden = false;
    const revision = state.shareRevision;
    try {
      const snapshot = window.EduHomeShare.buildSnapshot(state.data, { courseIds: [...state.shareIds], showName: $('homeShowName').checked, lang: language() });
      const result = await window.EduHomeShare.render(snapshot);
      if (revision !== state.shareRevision || !$('homeShareDialog').open) return;
      state.shareResult = result;
      state.previewUrl = URL.createObjectURL(result.blob);
      $('homeShareImage').src = state.previewUrl;
      $('homeShareImage').hidden = false;
      $('homeShareLoading').hidden = true;
      $('homeDownload').disabled = false;
      const file = new File([result.blob], result.filename, { type: 'image/png' });
      let supported = false;
      try { supported = typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] }); } catch (_) { /* PNG download is always available. */ }
      $('homeNativeShare').hidden = !supported;
      $('homeNativeShare').disabled = !supported;
    } catch (_) {
      if (revision !== state.shareRevision) return;
      $('homeShareLoading').hidden = true; shareError(tr('shareError'), true);
    }
  }
  async function openShare() {
    if (!state.data || state.loading || $('homeShare').disabled) return;
    const started = state.data.courses.filter(course => course.studiedTopics > 0 || course.masteredTopics > 0);
    state.shareIds = new Set((started.length ? started : state.data.courses).slice(0, 4).map(course => course.id));
    $('homeShowName').checked = true;
    renderShareChoices(); $('homeShareDialog').showModal();
    // Re-read progress so a newly opened card never starts with an old cached view.
    await load();
  }
  $('homeShare').addEventListener('click', openShare);
  $('homeShowName').addEventListener('change', renderShare);
  $('homeShareRetry').addEventListener('click', () => state.fresh ? renderShare() : load());
  $('homeShareDialog').addEventListener('close', clearShareResult);
  $('homeDownload').addEventListener('click', () => {
    const result = state.shareResult; if (!result) return;
    const url = URL.createObjectURL(result.blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = result.filename; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $('homeShareStatus').textContent = tr('saved');
  });
  $('homeNativeShare').addEventListener('click', async () => {
    const result = state.shareResult; if (!result) return;
    const file = new File([result.blob], result.filename, { type: 'image/png' });
    try { await navigator.share({ files: [file], title: tr('shareSheetTitle'), text: tr('shareText'), url: window.EduHomeShare.projectUrl }); }
    catch (error) { if (error.name !== 'AbortError') shareError(tr('nativeError')); }
  });
  $('homeEditName').addEventListener('click', () => {
    $('homeNameInput').value = state.data?.profile?.nickname || ''; $('homeNameError').hidden = true;
    $('homeNameDialog').showModal(); $('homeNameInput').focus();
  });
  $('homeNameForm').addEventListener('submit', async event => {
    event.preventDefault(); const nickname = $('homeNameInput').value.trim();
    if (!nickname || nickname.length > 20) { $('homeNameError').textContent = tr('nameError'); $('homeNameError').hidden = false; return; }
    $('homeNameSave').disabled = true; $('homeNameSave').textContent = tr('savingName');
    try {
      await request('/api/profile', { method: 'POST', body: JSON.stringify({ uid, nickname, avatar: state.data?.profile?.avatar || 'edupilot' }) });
      $('homeNameDialog').close();
      if (window.parent !== window) window.parent.postMessage({ type: 'edupilot:profile-updated' }, location.origin);
      await load(); announce(tr('nameSaved'));
    } catch (_) { $('homeNameError').textContent = tr('saveError'); $('homeNameError').hidden = false; }
    finally { $('homeNameSave').disabled = false; $('homeNameSave').textContent = tr('saveName'); }
  });
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $(button.dataset.closeDialog).close()));
  document.querySelectorAll('.home-dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  }));
  document.querySelectorAll('[data-course-filter]').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.courseFilter; renderFilters(); if (state.data) renderCourses(); }));
  $('homeSearch').addEventListener('input', () => { if (state.data) renderCourses(); });
  $('homeMoreSkills').addEventListener('click', () => { state.moreSkills = !state.moreSkills; renderSkills(); });
  $('homeLanguage').addEventListener('click', () => window.setEduLanguage(language() === 'en' ? 'zh' : 'en'));
  $('homeRetry').addEventListener('click', load);
  window.addEventListener('edu-language-change', () => { localize(); load(); });
  window.addEventListener('edu:navigation-status', event => {
    if (event.detail?.code === 'course_busy') { $('homeNavigationNotice').textContent = tr('courseBusy'); $('homeNavigationNotice').hidden = false; }
  });
  window.addEventListener('edu:activate', event => {
    state.active = event.detail?.active !== false;
    if (state.active) { $('homeNavigationNotice').hidden = true; window.applySettings?.(); load(); }
    else { state.revision++; state.controller?.abort(); clearShareResult(); for (const dialog of document.querySelectorAll('.home-dialog[open]')) dialog.close(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.active) load(); });
  window.addEventListener('pagehide', () => { state.revision++; state.controller?.abort(); clearShareResult(); });
  localize(); load();
})();
