/* Local, read-only spotlight tour. No chat, upload or model requests are sent. */
(function () {
  const $ = id => document.getElementById(id);
  const steps = [
    {
      element: '#courseSelect', sidebar: true,
      title: '先选择一门课程',
      text: '这里切换课程。推荐先体验内置 Python 演示课，无需 API Key；每门课分别保存对话和进度。',
    },
    {
      element: () => document.querySelector('#chapterList .kp-item') || $('courseSelect'), sidebar: true,
      title: '从一个知识点开始',
      text: '点击目录里的知识点，就会开始对应的预习或讲解。教程只展示位置，不会替你开始学习或改变进度。',
    },
    {
      element: '#journeySteps', sidebar: true,
      title: '按三个阶段逐步学习',
      text: '先做预习自测，再看讲解并完成随堂检测，最后通过复习检测，知识点才会标为已验证掌握。',
    },
    {
      element: '#input', sidebar: false,
      title: '在这里向学伴提问',
      text: '输入问题后按 Enter 发送，Shift + Enter 换行。“附件”辅助当前提问；导入整门课程要用下一步的“上传”。',
    },
    {
      element: '#addCourseBtn', sidebar: true,
      title: '把自己的教材导入课程',
      text: '从这里上传中英文 PDF、Word、PPT、Markdown、TXT 或 JSON。解析和默认向量化在本机完成；AI 生成讲义与题目并审核后，课程即可学习。',
    },
    {
      element: '#settingsBtn', sidebar: false,
      title: '模型、语言和字号都在设置里',
      text: '打开设置，在“LLM 模型”中配置供应商和密钥。教材生成与审核会使用模型额度；内置演示课和本教程无需付费调用。',
      action: '打开模型配置', target: 'llmChip',
    },
    {
      element: '#mistakeEntry', sidebar: true,
      title: '回到错题本巩固薄弱点',
      text: '答错的题会自动收录到这里，可重新练习。有进行中的测验或到期复习时，目录上方也会出现对应提醒。',
    },
    {
      element: '#reportLink', sidebar: false,
      title: '查看报告，继续学习',
      text: '这里查看课程进度、复习安排和错题记录。下次打开可接着学；顶部书本图标“教程”可以随时重看这份引导。',
      action: '查看学习报告', target: 'reportLink',
    },
  ];
  let storageKey = '', pending = false, tour = null, savedLayout = null;
  const app = document.querySelector('.app');

  function refresh() {
    if (!tour?.isActive()) return;
    window.setSidebar(steps[tour.getActiveIndex()].sidebar, false);
    tour.refresh();
  }

  function dismissed() {
    pending = false;
    localStorage.setItem(storageKey, 'seen');
    document.body.classList.remove('tutorial-active');
    app.inert = savedLayout.inert;
    if (savedLayout.mobile === matchMedia('(max-width: 860px)').matches) window.setSidebar(savedLayout.open, false);
    else window.restoreSidebar();
    $('courseSidebar').scrollTop = savedLayout.sidebarScroll;
    $('chapterList').scrollTop = savedLayout.chapterScroll;
    window.removeEventListener('resize', refresh);
    window.removeEventListener('scroll', refresh, true);
    $('tutorialBtn').focus();
  }

  function open() {
    if (!storageKey || tour?.isActive() || document.querySelector('.overlay:not(.hidden)')) return;
    savedLayout = {
      inert: app.inert, open: $('sidebarToggle').getAttribute('aria-expanded') === 'true',
      mobile: matchMedia('(max-width: 860px)').matches,
      sidebarScroll: $('courseSidebar').scrollTop, chapterScroll: $('chapterList').scrollTop,
    };
    document.body.classList.add('tutorial-active');
    app.inert = true;
    tour = window.driver.js.driver({
      animate: false, smoothScroll: false, overlayOpacity: .58, overlayColor: '#0f172a',
      stagePadding: 7, stageRadius: 8, popoverOffset: 12,
      disableActiveInteraction: true, overlayClickBehavior: 'none',
      popoverClass: 'tutorial-popover', showProgress: true, progressText: '{{current}} / {{total}}',
      nextBtnText: ui('下一步'), prevBtnText: ui('上一步'), doneBtnText: ui('开始学习'), closeBtnLabel: ui('关闭教程'),
      steps: steps.map(step => ({
        element: step.element,
        onHighlightStarted: element => {
          window.setSidebar(step.sidebar, false);
          element?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        },
        popover: { title: ui(step.title), description: ui(step.text), side: step.sidebar ? 'right' : 'bottom', align: 'start' },
      })),
      onPopoverRender(popover, { index }) {
        popover.wrapper.setAttribute('aria-modal', 'true');
        popover.description.setAttribute('aria-live', 'polite');
        const skip = document.createElement('button');
        skip.type = 'button'; skip.className = 'tutorial-skip'; skip.textContent = ui('稍后再看');
        skip.addEventListener('click', () => tour.destroy());
        popover.footer.insertBefore(skip, popover.footerButtons);
        const step = steps[index];
        if (step.action) {
          const action = document.createElement('button');
          action.type = 'button'; action.className = 'tutorial-action'; action.textContent = ui(step.action);
          action.addEventListener('click', () => { tour.destroy(); $(step.target).click(); });
          popover.description.append(action);
        }
      },
      onDestroyed: dismissed,
    });
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    tour.drive();
  }

  function showPending() { if (pending) open(); }
  window.EduOnboarding = {
    start(uid) {
      storageKey = 'eduowl_onboarding:v2:' + uid;
      pending = localStorage.getItem(storageKey) !== 'seen';
      $('tutorialBtn').disabled = false;
      showPending();
    },
    isActive: () => !!tour?.isActive(),
    // Let the preceding modal's Escape/click event finish before opening the tour.
    resume() { setTimeout(showPending, 0); },
  };
  $('tutorialBtn').addEventListener('click', open);
})();
