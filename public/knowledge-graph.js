/* Personal knowledge map. All progress and relation validation comes from server. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const uid = localStorage.getItem('eduowl_uid') || ('demo-' + Date.now());
  localStorage.setItem('eduowl_uid', uid);
  const courseId = params.get('course') || localStorage.getItem('eduowl_course') || 'python-intro';
  const sessionId = uid + '@' + courseId;
  const lang = () => window.eduLanguage?.() === 'en' ? 'en' : 'zh';
  const state = { graph: null, selected: params.get('node'), view: 'graph', zoom: 1, busy: false, loading: false, revision: 0, controller: null, active: true, noteDrafts: new Map() };
  const words = {
    zh: {
      brand: '连接知识，找到下一步', back: '返回对话', eyebrow: 'YOUR LEARNING MAP', title: '个人知识图谱',
      subtitle: '把课程、知识点与自己的理解连起来。', refresh: '刷新学习记录', loading: '正在整理你的知识关联…',
      suggestions: '接下来可以学什么', suggestionsNote: '依据已有作答与复习记录推荐', search: '搜索知识点', course: '课程', status: '学习状态',
      allCourses: '全部课程', allStatus: '全部状态', not_started: '未开始', practicing: '学习中', review_passed: '复习验证通过', review_due: '待复习',
      graph: '图谱', list: '列表', mapNote: '细线表示课程结构；箭头表示建议先学；虚线表示待确认或内容关联。选择知识点查看依据。',
      selectTitle: '从一个知识点开始', selectText: '选择图中的知识点，查看学习记录、相关内容，或记下自己的理解。',
      learn: '回到课程学习', practice: '做一道诊断练习', evidence: '学习依据', evidenceNote: '首答通过记录与复习验证分别保留；笔记和关联不会改变学习成绩。',
      connections: '知识关联', connectTo: '关联到', relation: '关系', related: '内容相关', prerequisite: '建议先学当前知识点', applies_to: '当前知识用于目标知识',
      whyConnect: '关联理由', saveLink: '保存关联', myNote: '我的理解', saveNote: '保存笔记', source: '内容来源',
      concepts: '知识点', reviewed: '复习验证通过', due: '待复习', links: '个人关联', noMatch: '没有匹配的知识点，试试调整筛选条件。',
      shown: '图中 {n} / {total} 个知识点；其余可搜索或切换列表查看', listCount: '{n} 个知识点', noRecommendations: '目前没有待处理的学习建议，可以浏览课程或添加自己的关联。',
      evidenceText: '测验累计 {total} 次作答、{correct} 次正确；最近保留的代码作答 {coding} 次、{codingCorrect} 次通过。新题首答通过记录 {independent} 条。',
      reviewYes: '已有复习测验通过凭据。', reviewNo: '尚无复习测验通过凭据。', noSummary: '可以从课程内容开始，逐步补充自己的理解。',
      outlineSource: '课程大纲', curated_course_map: '内置课程学习路径建议', personal: '你保存的关联', title_match: '同名内容候选，尚未确认',
      relationRelated: '内容相关', relationBefore: '建议先学', relationUsed: '用于理解', confirmLink: '确认内容相关', remove: '删除关联',
      confirmRemove: '删除这条个人关联？学习记录与其他关联会保留。', chooseTarget: '选择一个知识点', noConnections: '暂时没有内容关联，可以在下方添加。',
      savedNote: '笔记已保存。', savedLink: '关联已保存。', deleted: '关联已删除。', loadError: '知识图谱暂时无法加载，请检查连接并刷新。',
      operationError: '这次操作未完成，请重试。', unknown_concept: '知识点已变化，请刷新图谱后重试。', invalid_relation: '请选择两个不同的知识点和有效关系。',
      prerequisite_cycle: '这条先学关系会形成循环，请调整方向或改为“内容相关”。', note_too_long: '关联理由最多 500 字。', invalid_note: '笔记最多 2000 字。',
      course_not_found: '课程已删除或发生变化，请刷新图谱。', graph_changed: '图谱刚刚发生变化，请刷新后重试。',
      python_unavailable: '知识图谱需要可用的 Python 环境，请检查安装后重试。', graph_timeout: '整理图谱超时，请稍后重试。',
      truncated: '本次载入 {courses} / {totalCourses} 门课程、{n} / {total} 个知识点。', filteredSelected: '已定位知识点。', legacyEvidence: '部分首答记录来自旧版规则，保留原有口径。',
      stale_generation: '学习记录已重置，请刷新后重试。', course_deleted: '课程已删除，请刷新知识图谱。',
      saving: '正在保存…', missingSource: '来自课程大纲；当前知识点没有独立的文档定位信息。',
    },
    en: {
      brand: 'Connect ideas. Find your next step.', back: 'Back to chat', eyebrow: 'YOUR LEARNING MAP', title: 'Personal knowledge map',
      subtitle: 'Connect your courses, concepts and understanding.', refresh: 'Refresh progress', loading: 'Organizing your knowledge map…',
      suggestions: 'Where to go next', suggestionsNote: 'Based on recorded practice and review', search: 'Search concepts', course: 'Course', status: 'Learning status',
      allCourses: 'All courses', allStatus: 'All statuses', not_started: 'Not started', practicing: 'In progress', review_passed: 'Review check passed', review_due: 'Review due',
      graph: 'Map', list: 'List', mapNote: 'Thin lines show course structure; arrows suggest prerequisites; dashed lines show associations. Select a concept to see the evidence.',
      selectTitle: 'Start with one concept', selectText: 'Choose a concept to explore its progress and connections, or add your own understanding.',
      learn: 'Open course', practice: 'Try a diagnostic exercise', evidence: 'Learning evidence', evidenceNote: 'First-attempt checks and review assessments are separate. Notes and connections do not change your results.',
      connections: 'Connections', connectTo: 'Connect to', relation: 'Relationship', related: 'Related content', prerequisite: 'Study this concept first', applies_to: 'Apply this concept to the target',
      whyConnect: 'Why they connect', saveLink: 'Save connection', myNote: 'My understanding', saveNote: 'Save note', source: 'Content source',
      concepts: 'Concepts', reviewed: 'Review check passed', due: 'Review due', links: 'Personal links', noMatch: 'No matching concepts. Try another search or filter.',
      shown: '{n} / {total} concepts on the map; search or use the list for more', listCount: '{n} concepts', noRecommendations: 'No pending suggestions. Explore your courses or add a connection of your own.',
      evidenceText: '{total} quiz answers, {correct} correct; {coding} retained coding attempts, {codingCorrect} passed. {independent} first-attempt checks on fresh tasks.',
      reviewYes: 'A passed review assessment is recorded.', reviewNo: 'No passed review assessment is recorded yet.', noSummary: 'Explore the course and add your understanding as you learn.',
      outlineSource: 'Course outline', curated_course_map: 'Curated course study route', personal: 'Your saved connection', title_match: 'Same-title candidate, unconfirmed',
      relationRelated: 'Related to', relationBefore: 'Suggested before', relationUsed: 'Applied to', confirmLink: 'Confirm related content', remove: 'Delete connection',
      confirmRemove: 'Delete this personal connection? Your learning records and other connections will remain.', chooseTarget: 'Choose a concept', noConnections: 'No content connections yet. Add one below.',
      savedNote: 'Note saved.', savedLink: 'Connection saved.', deleted: 'Connection deleted.', loadError: 'The map could not be loaded. Check your connection and refresh.',
      operationError: 'The action did not complete. Please try again.', unknown_concept: 'The concept has changed. Refresh the map and try again.', invalid_relation: 'Choose two different concepts and a valid relationship.',
      prerequisite_cycle: 'This prerequisite would create a cycle. Change its direction or use “Related content”.', note_too_long: 'A connection reason can contain up to 500 characters.', invalid_note: 'A note can contain up to 2,000 characters.',
      course_not_found: 'The course was removed or changed. Refresh the map.', graph_changed: 'The map has changed. Refresh and try again.',
      python_unavailable: 'A working Python installation is needed for this map.', graph_timeout: 'The map took too long to build. Please try again.',
      truncated: 'Loaded {courses} / {totalCourses} courses and {n} / {total} concepts.', filteredSelected: 'Concept selected.', legacyEvidence: 'Some first-attempt records use an earlier rule version.',
      stale_generation: 'Learning records were reset. Refresh and try again.', course_deleted: 'The course was removed. Refresh the map.',
      saving: 'Saving…', missingSource: 'From the course outline; no separate document location is recorded for this concept.',
    },
  };
  const tr = (key, args = {}) => Object.entries(args).reduce((value, [k, v]) => value.replaceAll('{' + k + '}', String(v)), words[lang()][key] || key);
  const element = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = value; return node; };
  const svg = (tag, attrs = {}, value) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); if (value != null) node.textContent = value; return node; };
  const concepts = () => state.graph?.nodes.filter(n => n.kind === 'concept') || [];
  const selected = () => concepts().find(n => n.id === state.selected);
  function announce(value) { $('kgAnnouncement').textContent = value; }
  function showError(value) { $('kgError').textContent = value; $('kgError').hidden = !value; }
  function localize() {
    document.documentElement.lang = lang() === 'en' ? 'en' : 'zh-CN';
    document.title = 'EduPilot · ' + tr('title');
    document.querySelectorAll('[data-kg]').forEach(node => { node.textContent = tr(node.dataset.kg); });
    $('kgBack').href = '/?course=' + encodeURIComponent(courseId) + '&lang=' + lang();
    $('kgSearch').placeholder = tr('search');
    window.applySettings?.();
  }
  async function request(url, options = {}) {
    const response = await (window.eduFetch || fetch)(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    let result;
    try { result = await response.json(); } catch (_) { throw new Error(tr('operationError')); }
    if (!response.ok || result.ok === false) {
      const code = result.code || result.error;
      throw new Error(words[lang()][code] || tr('operationError'));
    }
    return result;
  }
  async function load() {
    if (state.busy) return;
    const revision = ++state.revision;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    $('kgRefresh').disabled = true;
    showError('');
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const graph = await request('/api/knowledge-graph?sessionId=' + encodeURIComponent(sessionId) + '&lang=' + lang(), { signal: controller.signal });
      if (revision !== state.revision) return;
      state.graph = graph;
      if (!selected()) state.selected = null;
      const currentFilter = $('kgCourse').value;
      $('kgCourse').replaceChildren(new Option(tr('allCourses'), 'all'));
      for (const course of graph.courses) $('kgCourse').append(new Option(course.title, course.id));
      $('kgCourse').value = [...$('kgCourse').options].some(o => o.value === currentFilter) ? currentFilter : 'all';
      $('kgLoading').hidden = true;
      $('kgContent').hidden = false;
      render();
    } catch (error) {
      if (revision === state.revision) showError(error.name === 'AbortError' ? tr('graph_timeout') : error.message || tr('loadError'));
      if (!state.graph) $('kgLoading').hidden = true;
    } finally {
      clearTimeout(timer);
      if (revision === state.revision) { state.loading = false; $('kgRefresh').disabled = false; }
    }
  }
  function filtered() {
    const query = $('kgSearch').value.trim().toLocaleLowerCase();
    const course = $('kgCourse').value, status = $('kgStatus').value;
    return concepts().filter(n => (course === 'all' || n.courseId === course) && (status === 'all' || n.progress.status === status)
      && (!query || [n.title, n.summary, n.courseTitle, n.chapterTitle, n.note].join(' ').toLocaleLowerCase().includes(query)));
  }
  function render() {
    if (!state.graph) return;
    const summary = state.graph.summary;
    $('kgStats').replaceChildren();
    for (const [key, value] of [['concepts', summary.concepts], ['reviewed', summary.reviewPassed], ['due', summary.reviewDue], ['links', summary.personalLinks]]) {
      const card = element('div', 'kg-stat'); card.append(element('strong', '', value), element('span', '', tr(key))); $('kgStats').append(card);
    }
    $('kgRecommendations').replaceChildren();
    for (const item of state.graph.recommendations.slice(0, 3)) {
      const card = element('button', 'kg-recommendation'); card.type = 'button';
      card.append(element('strong', '', item.title), element('span', '', item.reason)); card.addEventListener('click', () => select(item.nodeId, true)); $('kgRecommendations').append(card);
    }
    if (!state.graph.recommendations.length) $('kgRecommendations').append(element('p', 'kg-empty', tr('noRecommendations')));
    $('kgNotice').textContent = state.graph.notice + (summary.truncated ? ' ' + tr('truncated', { n: summary.concepts, total: summary.totalConcepts, courses: summary.courses, totalCourses: summary.totalCourses }) : '');
    renderMap(); renderDetail();
  }
  function select(id, reveal = false) {
    if (state.busy) return;
    state.selected = id;
    const url = new URL(location.href); url.searchParams.set('node', id); history.replaceState(history.state, '', url);
    if (reveal) { $('kgSearch').value = ''; $('kgCourse').value = 'all'; $('kgStatus').value = 'all'; }
    renderMap(); renderDetail();
    announce(tr('filteredSelected'));
    if (matchMedia('(max-width: 850px)').matches) $('kgDetailContent').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function renderMap() {
    if (!state.graph) return;
    const matching = filtered();
    const visible = matching.slice(0, 60);
    if (state.selected && matching.some(n => n.id === state.selected) && !visible.some(n => n.id === state.selected)) visible[visible.length - 1] = selected();
    $('kgVisibleCount').textContent = state.view === 'list' ? tr('listCount', { n: matching.length }) : tr('shown', { n: visible.length, total: matching.length });
    $('kgGraphViewport').hidden = state.view !== 'graph'; $('kgList').hidden = state.view !== 'list';
    $('kgGraphTab').setAttribute('aria-pressed', state.view === 'graph'); $('kgListTab').setAttribute('aria-pressed', state.view === 'list');
    document.querySelector('.kg-zoom').hidden = state.view !== 'graph';
    renderList(matching);
    const graph = $('kgGraph'); graph.replaceChildren(svg('title', { id: 'kgSvgTitle' }, tr('title')));
    if (!visible.length) {
      graph.setAttribute('viewBox', '0 0 1000 500'); graph.setAttribute('height', '500');
      graph.append(svg('text', { x: 500, y: 220, 'text-anchor': 'middle', fill: '#7b8773', 'font-size': 15 }, tr('noMatch'))); return;
    }
    const definitions = svg('defs');
    const marker = svg('marker', { id: 'kgArrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#91ad87' })); definitions.append(marker); graph.append(definitions);
    const positions = new Map(), allNodes = new Map(state.graph.nodes.map(n => [n.id, n]));
    let y = 55;
    for (const course of state.graph.courses) {
      const group = visible.filter(n => n.courseId === course.id); if (!group.length) continue;
      const start = y;
      for (const chapterId of [...new Set(group.map(n => n.parent))]) {
        const members = group.filter(n => n.parent === chapterId), chapterStart = y;
        for (const node of members) { positions.set(node.id, { x: 620, y, kind: 'concept' }); y += 72; }
        positions.set(chapterId, { x: 320, y: (chapterStart + y - 72) / 2, kind: 'chapter' }); y += 20;
      }
      const firstChapter = allNodes.get(group[0].parent);
      if (firstChapter) positions.set(firstChapter.parent, { x: 95, y: (start + y - 92) / 2, kind: 'course' });
      y += 45;
    }
    const height = Math.max(500, y);
    graph.setAttribute('viewBox', `0 0 1000 ${height}`); graph.setAttribute('height', height * state.zoom); graph.style.width = (state.zoom * 100) + '%';
    for (const edge of state.graph.edges) {
      const a = positions.get(edge.source), b = positions.get(edge.target); if (!a || !b) continue;
      let d;
      if (edge.relation === 'contains') {
        const fromX = a.x + (a.kind === 'course' ? 22 : 10), toX = b.kind === 'concept' ? 490 : b.x - 10;
        d = `M ${fromX} ${a.y} C ${(fromX + toX) / 2} ${a.y}, ${(fromX + toX) / 2} ${b.y}, ${toX} ${b.y}`;
      } else {
        const bow = Math.min(995, 825 + Math.abs(a.y - b.y) * .16);
        d = `M 798 ${a.y + 9} C ${bow} ${a.y + 9}, ${bow} ${b.y - 9}, 798 ${b.y - 9}`;
      }
      const line = svg('path', { d, class: 'kg-edge', 'data-relation': edge.relation,
        'data-selected': edge.source === state.selected || edge.target === state.selected });
      if (edge.relation === 'prerequisite') line.setAttribute('marker-end', 'url(#kgArrow)');
      line.append(svg('title', {}, edge.note || tr('outlineSource'))); graph.append(line);
    }
    for (const [id, p] of positions) {
      const node = allNodes.get(id); if (!node) continue;
      const group = svg('g', { class: 'kg-node', 'data-kind': node.kind, transform: `translate(${p.x} ${p.y})` });
      group.append(svg('title', {}, node.title));
      if (node.kind === 'concept') {
        group.setAttribute('data-status', node.progress.status); group.setAttribute('role', 'button'); group.setAttribute('tabindex', '0');
        group.setAttribute('aria-pressed', node.id === state.selected); group.setAttribute('aria-label', node.title + ', ' + tr(node.progress.status));
        group.append(svg('rect', { x: -130, y: -24, width: 308, height: 48, rx: 8 }));
        const title = [...node.title]; group.append(svg('text', { x: -114, y: 4 }, title.length > 29 ? title.slice(0, 28).join('') + '…' : node.title));
        group.addEventListener('click', () => select(id)); group.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(id); } });
      } else {
        group.append(svg('circle', { r: node.kind === 'course' ? 22 : 9 }));
        const title = [...node.title]; group.append(svg('text', { x: 0, y: node.kind === 'course' ? 42 : 29, 'text-anchor': 'middle' }, title.length > 20 ? title.slice(0, 19).join('') + '…' : node.title));
      }
      graph.append(group);
    }
  }
  function renderList(nodes) {
    $('kgList').replaceChildren();
    for (const node of nodes) {
      const row = element('button', 'kg-list-row'); row.type = 'button'; row.setAttribute('aria-pressed', node.id === state.selected);
      const copy = element('div'); copy.append(element('strong', '', node.title), element('small', '', node.courseTitle + ' · ' + node.chapterTitle));
      row.append(element('i', 'kg-dot kg-' + node.progress.status), copy, element('span', '', tr(node.progress.status)));
      row.addEventListener('click', () => select(node.id)); $('kgList').append(row);
    }
    if (!nodes.length) $('kgList').append(element('p', 'kg-empty', tr('noMatch')));
  }
  function renderDetail() {
    const node = selected(); $('kgDetailEmpty').hidden = !!node; $('kgDetailContent').hidden = !node;
    if (!node) return;
    $('kgBreadcrumb').textContent = node.courseTitle + ' · ' + node.chapterTitle;
    $('kgNodeTitle').textContent = node.title; $('kgNodeStatus').textContent = tr(node.progress.status);
    $('kgNodeSummary').textContent = node.summary || tr('noSummary');
    $('kgKeyPoints').replaceChildren(...node.keyPoints.map(p => element('li', '', p)));
    $('kgLearnLink').href = node.href + '&lang=' + lang();
    $('kgPracticeLink').hidden = !node.practiceHref; if (node.practiceHref) $('kgPracticeLink').href = node.practiceHref + '&lang=' + lang();
    const progress = node.progress;
    $('kgNodeEvidence').textContent = tr('evidenceText', { total: progress.quizTotal, correct: progress.quizCorrect, coding: progress.codingAttempts || 0, codingCorrect: progress.codingCorrect || 0, independent: progress.independentChecks })
      + ' ' + tr(progress.reviewPassed ? 'reviewYes' : 'reviewNo')
      + (progress.evidenceRuleVersions.includes('legacy') ? ' ' + tr('legacyEvidence') : '');
    $('kgNote').value = state.noteDrafts.has(node.id) ? state.noteDrafts.get(node.id) : node.note;
    $('kgNoteCount').textContent = $('kgNote').value.length + ' / 2000';
    $('kgSources').replaceChildren();
    $('kgSources').append(element('p', '', node.courseTitle + ' · ' + node.chapterTitle));
    for (const source of node.sources) $('kgSources').append(element('p', '', Object.values(source).filter(Boolean).join(' · ')));
    if (!node.sources.length) $('kgSources').append(element('p', 'kg-muted', tr('missingSource')));
    $('kgLinkTarget').replaceChildren(new Option(tr('chooseTarget'), ''));
    for (const other of concepts()) if (other.id !== node.id) $('kgLinkTarget').append(new Option(other.courseTitle + ' · ' + other.title, other.id));
    $('kgConnections').replaceChildren();
    const byId = new Map(concepts().map(n => [n.id, n]));
    const connections = state.graph.edges.filter(e => e.relation !== 'contains' && [e.source, e.target].includes(node.id));
    for (const edge of connections) {
      const other = byId.get(edge.source === node.id ? edge.target : edge.source); if (!other) continue;
      const box = element('div', 'kg-connection');
      const title = element('button', '', other.title); title.type = 'button'; title.addEventListener('click', () => select(other.id, true)); box.append(title);
      const direction = edge.relation === 'prerequisite' ? (edge.source === node.id ? node.title + ' → ' + other.title : other.title + ' → ' + node.title)
        : tr(edge.relation === 'applies_to' ? 'relationUsed' : 'relationRelated');
      box.append(element('small', '', direction + ' · ' + tr(edge.provenance)), element('p', '', edge.note));
      if (edge.editable) {
        const remove = element('button', 'kg-remove', tr('remove')); remove.type = 'button';
        remove.addEventListener('click', () => { if (confirm(tr('confirmRemove'))) mutate('/api/knowledge-graph/links/' + encodeURIComponent(edge.id), 'DELETE', {}, 'deleted'); }); box.append(remove);
      } else if (!edge.confirmed) {
        const confirm = element('button', '', tr('confirmLink')); confirm.type = 'button';
        confirm.addEventListener('click', () => mutate('/api/knowledge-graph/links', 'POST', { source: edge.source, target: edge.target, relation: 'related', note: '' }, 'savedLink')); box.append(confirm);
      }
      $('kgConnections').append(box);
    }
    if (!connections.length) $('kgConnections').append(element('p', 'kg-muted', tr('noConnections')));
  }
  async function mutate(url, method, body, message) {
    if (state.busy || state.loading) return;
    state.busy = true; showError(''); announce(tr('saving'));
    document.querySelectorAll('.kg-form button,.kg-connection button,#kgRefresh').forEach(b => { b.disabled = true; });
    try {
      await request(url, { method, body: JSON.stringify({ sessionId, ...body }) });
      if (message === 'savedNote') state.noteDrafts.delete(body.nodeId);
      announce(tr(message)); state.busy = false; await load();
    } catch (error) { showError(error.message || tr('operationError')); }
    finally { state.busy = false; document.querySelectorAll('.kg-form button,.kg-connection button,#kgRefresh').forEach(b => { b.disabled = false; }); }
  }
  $('kgRefresh').addEventListener('click', load);
  $('kgSearch').addEventListener('input', renderMap); $('kgCourse').addEventListener('change', renderMap); $('kgStatus').addEventListener('change', renderMap);
  $('kgGraphTab').addEventListener('click', () => { state.view = 'graph'; renderMap(); }); $('kgListTab').addEventListener('click', () => { state.view = 'list'; renderMap(); });
  function zoom(value) { state.zoom = Math.max(.75, Math.min(1.75, value)); $('kgZoomReset').textContent = Math.round(state.zoom * 100) + '%'; renderMap(); }
  $('kgZoomOut').addEventListener('click', () => zoom(state.zoom - .25)); $('kgZoomIn').addEventListener('click', () => zoom(state.zoom + .25)); $('kgZoomReset').addEventListener('click', () => zoom(1));
  $('kgNote').addEventListener('input', () => { if (selected()) state.noteDrafts.set(state.selected, $('kgNote').value); $('kgNoteCount').textContent = $('kgNote').value.length + ' / 2000'; });
  $('kgNoteForm').addEventListener('submit', event => { event.preventDefault(); if (selected()) mutate('/api/knowledge-graph/notes', 'PUT', { nodeId: state.selected, text: $('kgNote').value }, 'savedNote'); });
  $('kgLinkForm').addEventListener('submit', event => { event.preventDefault(); if (selected()) mutate('/api/knowledge-graph/links', 'POST', { source: state.selected, target: $('kgLinkTarget').value, relation: $('kgRelation').value, note: $('kgLinkNote').value }, 'savedLink'); });
  window.addEventListener('edu-language-change', () => { localize(); if (state.active) load(); });
  window.addEventListener('edu:activate', event => { state.active = event.detail?.active !== false; if (state.active) { localize(); load(); } });
  window.addEventListener('storage', event => { if (event.key === 'eduowl_uid' && event.newValue !== uid) location.reload(); });
  window.addEventListener('edu-course-deleted', () => { if (state.active) load(); });
  window.addEventListener('edu-course-renamed', () => { if (state.active) load(); });
  window.addEventListener('pagehide', () => { state.active = false; state.controller?.abort(); });
  localize(); load();
})();
