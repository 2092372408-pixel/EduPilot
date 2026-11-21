/* Local, read-only spotlight tour. No chat, upload or model requests are sent. */
(function () {
  const $ = id => document.getElementById(id);
  const steps = [
    {
      element: '#courseSelect', sidebar: true,
      title: '先选择一门课程',
      text: '选择内置 Python 课程或自己导入的课程，再从目录进入预习、学习与复习。每门课分别保存对话和进度，通过复习检测后才会标为已验证掌握。',
    },
    {
      element: '#input', sidebar: false,
      title: '在这里向学伴提问',
      text: '输入问题后按 Enter 发送，Shift + Enter 换行。“附件”辅助当前提问；导入整门课程请用侧栏的“上传”。',
    },
    {
      element: '#learningLabLink', sidebar: true,
      title: '用一道新题检验理解',
      text: '诊断练习目前支持内置 Python 课程的分支、循环和函数。先尝试、按需获取提示并订正，再独立完成一道新题；提示使用与独立作答分别记录。',
      action: '打开 Python 诊断练习', activate: () => window.EduNavigation.navigate('/learning-lab.html?course=python-intro'),
    },
    {
      element: '#knowledgeGraphLink', sidebar: true,
      title: '把知识和自己的理解连起来',
      text: '图谱汇集课程知识点与学习记录。可以添加知识关联、记录自己的理解，也能从待复习和薄弱知识点回到课程继续学习。',
      action: '打开知识图谱', target: 'knowledgeGraphLink',
    },
    {
      element: '#chatRunActivity summary', sidebar: true,
      title: '知道学习任务进行到了哪一步',
      text: '活动记录显示当前对话的处理进度、完成情况与中断原因。可继续的任务会显示“继续执行”按钮，由你决定何时接着完成。',
      action: '查看学习活动', activate: () => window.openLearningActivity(),
    },
    {
      element: '#addCourseBtn', sidebar: true,
      title: '把自己的教材导入课程',
      text: '上传 PDF、Word、PPT、Markdown、TXT 或 JSON，创建新课程或给已有课程补充材料。导入后按章节开始学习；讲解与题目按需生成。',
    },
    {
      element: '.course-manage > summary', sidebar: true,
      title: '课程多了，也能有条理地管理',
      text: '打开课程管理，可查找、改名或单独删除上传的课程，不必先切换到那门课。删除前会说明范围并请你确认；内置 Python 课程始终保留。',
      action: '管理全部课程', target: 'manageCoursesBtn',
    },
    {
      element: '#settingsBtn', sidebar: false,
      title: '模型、语言和字号都在设置里',
      text: '需要 AI 讲解、问答或出题时，在“AI 模型”中配置供应商、模型和 API Key。相关请求会使用你的模型额度；查看已有记录和本教程无需调用模型。',
      action: '打开模型配置', target: 'llmChip',
    },
    {
      element: '#reportLink', sidebar: true,
      title: '查看报告，继续学习',
      text: '报告汇总课程进度、复习安排和作答记录，错题也可从侧栏再次练习。下次打开继续学习；顶部“教程”可随时重看这份引导。',
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
          action.addEventListener('click', () => { tour.destroy(); if (step.activate) step.activate(); else $(step.target).click(); });
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
      // Preserve dismissals across upgrades; the updated guide remains replayable.
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
