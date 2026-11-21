/* Course management stays in the learning app and works on any selected row. */
(() => {
  'use strict';
  let config, dialog, opener, heading, description, search, list, status, closeButton;
  let rows = [], pending = [], busy = false, requestVersion = 0;
  const en = () => config?.language() === 'en';
  const text = (zh, english) => en() ? english : zh;
  const element = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const button = (label, action, className = '') => {
    const node = element('button', 'btn-ghost small ' + className, label);
    node.type = 'button'; node.addEventListener('click', action);
    return node;
  };
  function message(value, error = false) {
    status.textContent = value;
    status.classList.toggle('course-manager-error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  }
  function setBusy(value) {
    busy = value;
    dialog.setAttribute('aria-busy', String(value));
    search.disabled = value; closeButton.disabled = value;
    dialog.querySelectorAll('button,input').forEach(node => { node.disabled = value; });
  }
  async function load() {
    const version = ++requestVersion;
    message(text('正在读取课程…', 'Loading courses…'));
    try {
      const result = await config.list();
      if (version !== requestVersion) return;
      rows = result.courses || []; pending = result.pendingDeletions || [];
      render(); message(text(`${rows.length} 门课程`, `${rows.length} courses`));
    } catch (error) {
      if (version === requestVersion) message(text('无法读取课程：', 'Could not load courses: ') + error.message, true);
    }
  }
  function render() {
    heading.textContent = text('管理课程', 'Manage courses');
    description.textContent = text('查看课程，修改名称，或删除不再需要的上传教材。', 'Browse courses, rename them, or delete uploaded material you no longer need.');
    search.placeholder = text('搜索课程名称', 'Search courses');
    search.setAttribute('aria-label', search.placeholder);
    closeButton.textContent = text('关闭', 'Close');
    list.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const selected = rows.filter(row => String(row.title).toLocaleLowerCase().includes(query));
    const unfinished = pending.filter(row => String(row.title).toLocaleLowerCase().includes(query));
    for (const row of [...selected, ...unfinished.map(row => ({ ...row, pendingCleanup: true }))]) {
      const card = element('section', 'course-manager-row');
      card.dataset.courseId = row.id;
      const main = element('div', 'course-manager-row-main');
      const title = element('h3', '', row.title);
      const meta = [];
      if (row.pendingCleanup) meta.push(text('已停用 · 待完成清理', 'Removed · cleanup pending'));
      else {
        meta.push(row.source === 'builtin' ? text('内置课程', 'Built-in course') : text('上传课程', 'Uploaded course'));
        if (row.chapterCount != null) meta.push(text(`${row.chapterCount} 章`, `${row.chapterCount} chapters`));
        if (row.id === config.current()) meta.push(text('正在学习', 'Current course'));
      }
      main.append(title, element('p', 'course-manager-meta', meta.join(' · ')));
      const actions = element('div', 'course-manager-actions');
      const form = element('div', 'course-manager-form');
      if (row.pendingCleanup) actions.append(button(text('重试清理', 'Retry cleanup'), () => remove(row)));
      else {
        actions.append(button(text('打开', 'Open'), async () => {
          if (busy) return;
          close(); await config.open(row.id);
        }));
        if (row.source !== 'builtin') {
          actions.append(button(text('改名', 'Rename'), () => renameForm(row, form)));
          actions.append(button(text('删除', 'Delete'), () => deleteForm(row, form), 'course-manager-danger'));
        }
      }
      card.append(main, actions, form); list.append(card);
    }
    if (!selected.length && !unfinished.length) list.append(element('p', 'course-manager-empty', text('没有匹配的课程', 'No matching courses')));
    if (busy) setBusy(true);
  }
  function clearForms() {
    list.querySelectorAll('.course-manager-form').forEach(node => node.replaceChildren());
  }
  function renameForm(row, form) {
    if (busy) return;
    clearForms();
    const label = element('label', '', text('新的课程名称', 'New course name'));
    const input = element('input'); input.type = 'text'; input.maxLength = 60; input.value = row.title;
    label.append(input);
    const actions = element('div', 'course-manager-actions');
    const save = async () => {
      const title = input.value.trim();
      if (!title) { input.focus(); message(text('请输入课程名称', 'Enter a course name'), true); return; }
      if (busy) return;
      setBusy(true); message(text('正在保存…', 'Saving…'));
      try {
        await config.rename(row.id, title);
        await load(); message(text('课程名称已更新', 'Course renamed'));
      } catch (error) { message(error.message, true); }
      finally { setBusy(false); }
    };
    actions.append(button(text('保存', 'Save'), save), button(text('取消', 'Cancel'), () => form.replaceChildren()));
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save(); } });
    form.append(label, actions); input.focus(); input.select();
  }
  function deleteForm(row, form) {
    if (busy) return;
    clearForms();
    const summary = text(`确定删除《${row.title}》？`, `Delete “${row.title}”?`);
    const details = text('这会移除本机各学习档案中这门课的教材、对话、学习记录和相关知识关联。其他课程不受影响。此操作无法撤销。', 'This removes this course’s material, conversations, learning records and knowledge links for all profiles in this installation. Other courses are kept. This cannot be undone.');
    const actions = element('div', 'course-manager-actions');
    const cancel = button(text('保留课程', 'Keep course'), () => form.replaceChildren());
    actions.append(cancel, button(text('确认删除', 'Delete course'), () => remove(row), 'course-manager-danger'));
    form.append(element('strong', '', summary), element('p', '', details), actions);
    cancel.focus();
  }
  async function remove(row) {
    if (busy) return;
    setBusy(true); message(text('正在清理这门课程…', 'Removing this course…'));
    try {
      const result = await config.remove(row.id);
      await load();
      message(result.ok ? text('课程已删除', 'Course deleted')
        : text('课程已停用，部分清理未完成。请点击“重试清理”。', 'The course was removed, but cleanup is incomplete. Select “Retry cleanup”.'), !result.ok);
    } catch (error) { message(error.message, true); }
    finally { setBusy(false); }
  }
  function close() {
    if (busy) return;
    ++requestVersion; dialog.close(); opener?.focus();
  }
  function open() {
    if (config.isBusy()) return;
    opener = document.activeElement;
    search.value = ''; render(); dialog.showModal(); search.focus(); load();
  }
  function init(options) {
    if (dialog) return;
    config = options;
    const entry = button(text('管理课程', 'Manage'), open);
    entry.id = 'manageCoursesBtn'; entry.title = text('管理全部课程', 'Manage all courses');
    document.querySelector('.course-tools')?.append(entry);
    dialog = element('dialog', 'course-manager'); dialog.id = 'courseManagerDialog';
    dialog.setAttribute('aria-labelledby', 'courseManagerTitle');
    const head = element('div', 'course-manager-head');
    heading = element('h2'); heading.id = 'courseManagerTitle';
    closeButton = button(text('关闭', 'Close'), close);
    head.append(heading, closeButton);
    description = element('p', 'course-manager-description');
    search = element('input', 'course-manager-search'); search.type = 'search';
    search.addEventListener('input', render);
    status = element('p', 'course-manager-status'); status.setAttribute('aria-live', 'polite');
    list = element('div', 'course-manager-list');
    dialog.append(head, description, search, status, list); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => { if (event.target === dialog && !busy) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    } });
    window.addEventListener('edu-language-change', () => {
      entry.textContent = text('管理课程', 'Manage');
      entry.title = text('管理全部课程', 'Manage all courses');
      if (dialog.open && !busy) { render(); load(); }
    });
    render();
  }
  window.EduCourseManager = { init, open, refresh: () => dialog?.open && load() };
})();
