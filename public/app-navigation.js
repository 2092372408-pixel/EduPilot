/* Keep feature views inside the app while preserving each view's working state. */
(function () {
  const views = {
    coding: { path: '/coding.html', title: '代码实践', link: 'codingLink' },
    choice: { path: '/choice.html', title: '选择题', link: 'choiceLink' },
    report: { path: '/report.html', title: '学习报告', link: 'reportLink' },
    upload: { path: '/upload.html', title: '上传学习素材' },
    exam: { path: '/exam.html', title: '期末大实践' },
  };
  const host = document.getElementById('featureHost');
  const embedded = window.parent !== window && new URLSearchParams(location.search).get('embedded') === '1';
  const internal = value => {
    const url = new URL(value, location.href);
    return url.origin === location.origin && (url.pathname === '/' || url.pathname === '/index.html' || Object.values(views).some(view => view.path === url.pathname)) ? url : null;
  };

  if (embedded) {
    let active = true;
    document.body.classList.add('app-embedded');
    window.EduNavigation = { navigate: href => window.parent.postMessage({ type: 'edupilot:navigate', href }, location.origin) };
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      if (event.data?.type === 'edupilot:select-topic') {
        window.dispatchEvent(new CustomEvent('edu:select-topic', { detail: { kpId: event.data.kpId } }));
        return;
      }
      if (event.data?.type !== 'edupilot:activate') return;
      const state = event.data;
      if (state.language && window.setEduLanguage && window.eduLanguage?.() !== state.language) window.setEduLanguage(state.language);
      window.applySettings?.();
      const visibilityChanged = active !== state.active;
      active = state.active;
      window.dispatchEvent(new CustomEvent('edu:activate', { detail: { ...state, visibilityChanged } }));
    });
  }

  if (host) {
    const frames = new Map();
    const chatPanel = document.querySelector('.chat-panel');
    let active = null;
    const course = () => typeof courseData !== 'undefined' && courseData?.id || localStorage.getItem('eduowl_course') || 'python-intro';
    const language = () => window.eduLanguage?.() || 'zh';
    const message = (frame, activeView, refresh) => frame.contentWindow?.postMessage({ type: 'edupilot:activate', active: activeView, refresh, language: language() }, location.origin);

    function renderLabels() {
      const selected = active && views[active.name];
      document.getElementById('featureTitle').textContent = selected ? ui(selected.title) : '';
      document.getElementById('workspaceTitle').textContent = selected ? ui(selected.title) : ui('学习对话');
      document.getElementById('featureBackBtn').textContent = ui('返回对话');
      const chatLink = document.getElementById('chatLink');
      if (selected) chatLink.removeAttribute('aria-current');
      else chatLink.setAttribute('aria-current', 'page');
      for (const view of Object.values(views)) {
        const link = view.link && document.getElementById(view.link);
        if (link) {
          if (view === selected) link.setAttribute('aria-current', 'page');
          else link.removeAttribute('aria-current');
        }
      }
    }

    async function navigate(value, { replace = false, pop = false } = {}) {
      const target = internal(value);
      if (!target) return false;
      const name = Object.keys(views).find(key => views[key].path === target.pathname) || (views[target.searchParams.get('view')] ? target.searchParams.get('view') : null);
      const targetCourse = target.searchParams.get('course') || active?.course || course();
      if (active?.name === name && active.course === targetCourse) {
        if (name === 'report') message(active.frame, true, true);
        return true;
      }
      if (!name && targetCourse !== course() && typeof switchCourse === 'function') {
        const previousUrl = location.href;
        const previousState = history.state;
        await switchCourse(targetCourse);
        history.replaceState(previousState, '', previousUrl);
      }
      if (active) { active.frame.hidden = true; message(active.frame, false, false); }
      active = null;
      if (name) {
        const key = `${name}@${targetCourse}`;
        let frame = frames.get(key);
        const fresh = !frame;
        if (!frame) {
          frame = document.createElement('iframe');
          frame.className = 'feature-frame';
          frame.title = ui(views[name].title);
          const url = new URL(views[name].path, location.origin);
          url.search = target.search;
          url.searchParams.delete('view');
          url.searchParams.set('course', targetCourse);
          url.searchParams.set('lang', language());
          url.searchParams.set('embedded', '1');
          frame.src = url.href;
          frame.addEventListener('load', () => {
            message(frame, active?.frame === frame, false);
            if (active?.frame === frame && ['coding', 'choice'].includes(name)) {
              const kpId = typeof learning !== 'undefined' && learning?.currentKpId || (typeof courseData !== 'undefined' && courseData?.chapters?.[0]?.knowledgePoints?.[0]?.id);
              if (kpId) window.EduNavigation.selectTopic(kpId);
            }
          });
          frames.set(key, frame);
          document.getElementById('featureFrames').appendChild(frame);
        }
        frame.hidden = false;
        active = { name, frame, course: targetCourse };
        if (!fresh) message(frame, true, name === 'report');
      }
      chatPanel.hidden = Boolean(active);
      host.hidden = !active;
      document.body.dataset.activeView = name || 'chat';
      if (typeof setSidebar === 'function' && matchMedia('(max-width: 860px)').matches) setSidebar(false, false);
      renderLabels();
      const url = new URL(location.href);
      url.pathname = '/';
      url.searchParams.delete('embedded');
      if (name) { url.searchParams.set('view', name); url.searchParams.set('course', targetCourse); }
      else { url.searchParams.delete('view'); url.searchParams.delete('course'); }
      if (!pop && url.href !== location.href) history[replace ? 'replaceState' : 'pushState']({ view: name }, '', url);
      if (!active) {
        if (typeof refreshSidebarProgress === 'function') refreshSidebarProgress();
        if (typeof refreshMistakeBadge === 'function') refreshMistakeBadge();
      }
      return true;
    }

    window.EduNavigation = {
      navigate,
      selectTopic(kpId) {
        if (!active || !['coding', 'choice'].includes(active.name)) return false;
        active.frame.contentWindow?.postMessage({ type: 'edupilot:select-topic', kpId }, location.origin);
        if (typeof highlightKp === 'function') highlightKp(kpId);
        if (typeof closeSidebar === 'function') closeSidebar();
        return true;
      },
      refreshLanguage() {
        renderLabels();
        for (const frame of frames.values()) {
          const view = Object.values(views).find(item => item.path === new URL(frame.src).pathname);
          frame.title = ui(view.title);
          message(frame, active?.frame === frame, false);
        }
      },
    };
    document.getElementById('featureBackBtn').addEventListener('click', () => navigate('/'));
    window.addEventListener('popstate', () => navigate(location.href, { pop: true }));
    window.addEventListener('edu-language-change', () => window.EduNavigation.refreshLanguage());
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== active?.frame.contentWindow || event.data?.type !== 'edupilot:navigate') return;
      if (internal(event.data.href)) navigate(event.data.href);
    });
    navigate(location.href, { replace: true });
  }

  if (host || embedded) document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || !internal(link.href)) return;
    event.preventDefault();
    event.stopPropagation();
    const navigation = window.EduNavigation.navigate(link.href);
    if (host && typeof link.onclick === 'function') Promise.resolve(navigation).then(() => link.onclick(event));
  }, true);
})();
