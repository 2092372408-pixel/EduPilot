/**
 * agent/scope.js — 课程边界闸门（联网检索只能在课程/编程领域内）
 * ------------------------------------------------------------
 * 动机：联网检索有配额与成本，且本产品定位是「只服务本课程学习」。学生打开联网开关后
 * 若问"今天天气怎么样""特斯拉股价多少"，不应真的去搜——那是滥用，也偏离教学职责。
 *
 * 判定（三层，先拒后放）：
 *   ① 明确无关领域（天气/股票/影视/旅游/美食/彩票/星座…）→ **拒绝**
 *   ② 课程词表命中（课标/章/知识点/教材正文）或编程·AI 领域词命中 → **允许**
 *   ③ 都不命中 → **拒绝**（按"必须与课程有关"的默认从严策略），并给出可操作提示
 *
 * 设计要点：
 *   - 词表按课程 **懒构建 + 缓存**（教材正文分词较重，只在首次判定时建一次）；
 *   - 中文用**二元组**切分（避免单字噪音），英文/标识符按词切分；
 *   - 纯函数 + 可注入课程，便于单测；判定失败一律"拒绝"（安全侧）。
 *
 * 与"元问题"的区别：元问题（问助手本身）也走拒绝；此处进一步覆盖"领域外问题"。
 */

const { course: builtinCourse } = require('../data/course');

/** 明确无关领域（命中即拒，优先级最高） */
const OFF_TOPIC = [
  // 天气环境
  '天气', '气温', '下雨', '台风', '空气质量', '雾霾',
  // 金融
  '股票', '股价', '基金', '基金净', '比特币', '加密货币', '汇率', '理财', '期货', '债券',
  // 影视娱乐
  '电影', '电视剧', '综艺', '明星', '八卦', '娱乐', '演唱会', '专辑', '票房',
  // 出行旅游
  '旅游', '景点', '机票', '酒店', '签证', '自驾', '出行',
  // 生活
  '美食', '菜谱', '做饭', '餐厅', '减肥', '减脂', '瘦身', '健身', '养生', '星座', '运势', '占卜', '算命',
  '限行', '尾号', '彩票', '房价', '购物', '优惠券', '带货', '电商', '直播', '穿搭', '护肤', '美妆',
  // 情感/文书
  '情书', '表白', '恋爱', '相亲', '小说', '作文', '论文代写', '写诗',
  // 医疗/法律/政务
  '医院', '挂号', '症状', '用药', '法律', '合同', '律师', '报税', '发票',
  // 体育
  '球赛', '比赛', '体育', '足球', '篮球',
];

/**
 * 编程 / AI 领域词（课程外但同领域 → 允许联网）。
 * 目的：学生问"Python 3.13 新特性""numpy 怎么装"属正当扩展，不该被课程词表挡住。
 */
const DOMAIN = [
  // 语言与工具链
  'python', 'pip', 'conda', 'venv', 'pipenv', 'poetry', 'jupyter', 'anaconda', 'ipython',
  'pycharm', 'vscode', 'ide', '解释器', '编译器', '命令行', '终端', 'shell', 'bash', 'powershell',
  // 其他编程语言（同属编程领域，问"什么是 Rust"应放行）
  'rust', 'java', 'javascript', 'js', 'typescript', 'ts', 'golang', 'go', 'cpp', 'c++', 'c#',
  'ruby', 'php', 'swift', 'kotlin', 'scala', 'perl', 'lua', 'dart', 'matlab', 'html', 'css',
  '程序设计', '编程语言', '面向对象编程',
  // 常用库
  'numpy', 'pandas', 'matplotlib', 'scipy', 'sklearn', 'scikit', 'pytorch', 'torch',
  'tensorflow', 'keras', 'django', 'flask', 'fastapi', 'requests', 'beautifulsoup', 'scrapy',
  'selenium', 'openpyxl', 'pytest', 'unittest', 'pillow', 'opencv',
  // 编程概念
  '编程', '代码', '程序', '语法', '脚本', '执行', '运行', '报错', '错误', '异常', '调试',
  'debug', 'bug', '崩溃', '日志', '变量', '常量', '类型', '数据类型', '字符串', '数字', '布尔',
  '运算', '运算符', '表达式', '条件', '分支', '循环', '遍历', '迭代', '递归', '生成器', '迭代器',
  '函数', '参数', '返回值', '作用域', '闭包', '装饰器', 'lambda', '模块', '包', '库', '依赖',
  '导入', '安装', '卸载', '升级', '版本', '环境', '虚拟环境', '类', '对象', '实例', '属性',
  '方法', '继承', '多态', '封装', '抽象', '构造', '析构', '魔法方法', '列表', '元组', '字典',
  '集合', '数组', '队列', '栈', '堆', '链表', '树', '图', '哈希', '排序', '查找', '二分',
  '算法', '数据结构', '复杂度', '时间复杂度', '空间复杂度', '面向对象', '函数式', '并发',
  '线程', '进程', '协程', '异步', '多线程', '文件', '读写', '编码', '解码', 'utf-8', '正则',
  '表达式', '测试', '单元测试', '断言', '重构', '设计模式', '规范', '注释', '文档',
  // AI / 数据
  '人工智能', '机器学习', '深度学习', '神经网络', '大模型', '训练', '微调', '推理', '数据',
  '数据分析', '数据处理', '爬虫', '抓取', '接口', 'api', '数据库', 'sql', 'sqlite', 'mysql',
  'redis', 'mongodb', 'git', 'github', 'gitlab', '版本控制', '部署', '容器', 'docker', '云',
  '服务器', '前端', '后端', '框架', 'web', 'http', 'json', 'csv', 'excel', 'xml', 'yaml',
  'ai', 'llm', 'gpt', 'transformer', 'gpu', 'cuda', '开源', '社区', '教程', '文档', '官方',
];

/**
 * 通用词停用表：这些词在教材/课标里出现，但**单独出现不能证明"与课程相关"**
 * （否则"我要学习奥特曼""推荐几部电影"都会因为含"学习/推荐"而被放行）。
 * 判定时先剔除这些词，再看是否还有课程/领域词命中。
 */
const GENERIC = [
  '学习', '学会', '怎么', '如何', '什么', '为什么', '哪些', '哪个', '多少', '几个', '介绍',
  '讲解', '解释', '说明', '推荐', '建议', '一下', '帮我', '麻烦', '请问', '想要', '需要',
  '可以', '应该', '能否', '是否', '问题', '内容', '方法', '方式', '特点', '区别', '比较',
  '入门', '基础', '开始', '继续', '练习', '做题', '课程', '知识', '概念', '原理', '例子', '示例',
];

/** 切词：英文按词，中文按二元组（避免单字噪音）；返回去重数组 */
function tokenize(text) {
  const t = String(text || '').toLowerCase();
  const words = t.match(/[a-z][a-z0-9_+#.-]*/g) || [];
  const grams = [];
  for (const run of (t.match(/[\u4e00-\u9fa5]+/g) || [])) {
    if (run.length === 1) { grams.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2));
  }
  return [...new Set([...words, ...grams])];
}

/* ---------------- 词表缓存（按课程懒构建） ---------------- */
const _cache = new Map(); // courseId → { allow:Set, deny:Set }

/** 构建某课程的"可联网词表"（课程标题/章/知识点/教材正文 + 领域词） */
function buildVocab(courseId) {
  const allow = new Set();
  for (const w of DOMAIN) { allow.add(w); for (const t of tokenize(w)) allow.add(t); }

  let view = null;
  try {
    const registry = require('../kb/course-registry');
    if (registry.isDynamicCourseId(courseId)) {
      const dyn = registry.getDynamicCourse(courseId);
      if (dyn) view = registry.dynamicCourseView(dyn);
    }
  } catch (_) { /* 动态课不可用时退回内置 */ }

  if (view) {
    for (const t of tokenize(view.title + ' ' + (view.description || ''))) allow.add(t);
    for (const ch of view.chapters || []) {
      for (const t of tokenize(ch.title)) allow.add(t);
      for (const kp of ch.knowledgePoints || []) for (const t of tokenize(kp.title)) allow.add(t);
    }
  } else {
    for (const t of tokenize(builtinCourse.title + ' ' + builtinCourse.description)) allow.add(t);
    for (const ch of builtinCourse.chapters) {
      for (const t of tokenize(ch.title)) allow.add(t);
      for (const kp of ch.knowledgePoints) {
        for (const t of tokenize([kp.title, kp.summary, (kp.keyPoints || []).join(' '), (kp.pitfalls || []).join(' ')].join(' '))) allow.add(t);
      }
    }
  }

  // 教材正文（RAG 语料）——课程词表最重要的一块
  try {
    const kb = require('../kb/search');
    const loaded = kb.loadKB(courseId);
    if (loaded && Array.isArray(loaded.chunks)) {
      for (const c of loaded.chunks) for (const t of tokenize(c.content)) allow.add(t);
    }
  } catch (_) { /* 无 KB 时仅用课标词表 */ }

  const deny = new Set();
  for (const w of OFF_TOPIC) { deny.add(w); for (const t of tokenize(w)) deny.add(t); }

  return { allow, deny };
}

function vocabOf(courseId) {
  const key = courseId || builtinCourse.id;
  if (!_cache.has(key)) _cache.set(key, buildVocab(key));
  return _cache.get(key);
}

/** 清空词表缓存（上传新课程/重建索引后调用） */
function invalidate(courseId) {
  if (courseId) _cache.delete(courseId); else _cache.clear();
}

/**
 * 判断某个问题是否"在课程允许联网的范围内"。
 * @param {string} message 学生问题
 * @param {object} [opts] { courseId }
 * @returns {{ allowed:boolean, reason:'off-topic'|'no-match'|'matched'|'empty', matched:string[] }}
 */
function checkWebScope(message, opts = {}) {
  const msg = String(message || '').trim();
  if (!msg) return { allowed: false, reason: 'empty', matched: [] };
  const { allow, deny } = vocabOf(opts.courseId);

  const toks = tokenize(msg);
  // ① 明确无关领域 → 直接拒绝
  const off = toks.filter((t) => deny.has(t));
  if (off.length) return { allowed: false, reason: 'off-topic', matched: off.slice(0, 3) };

  // ② 课程/领域词命中 → 允许（先剔除通用词：它们单独出现不能证明与课程相关）
  const generic = new Set([...GENERIC, ...tokenize(GENERIC.join(' '))]);
  const meaningful = toks.filter((t) => !generic.has(t));
  const hit = meaningful.filter((t) => allow.has(t));
  const domain = DOMAIN.some(word => /^[a-z]/i.test(word) ? toks.includes(word) : word.length > 1 && msg.includes(word));
  // One shared Chinese bigram (光合作用 / 作用域) is insufficient evidence of course relevance.
  if (domain || hit.length >= 2 || hit.some(t => /^[a-z][a-z0-9_+#.-]{3,}$/i.test(t))) return { allowed: true, reason: 'matched', matched: hit.slice(0, 5) };

  // ③ 都不命中 → 拒绝（默认从严：联网必须与课程有关）
  return { allowed: false, reason: 'no-match', matched: [] };
}

/* -------- 课外实体提问（"X是什么"但 X 与课程/领域无关） -------- */

/** 问句型式：「什么是X」「X是什么」等 */
const ASK_ABOUT_RE = /(?:什么是|是什么|啥是|什么叫|啥叫)\s*([^\s，。？！?,.!]{1,12})|([^\s，。？！?,.!]{1,12})\s*(?:是什么|是啥|指什么|什么意思)/;
/** 这些词不构成"实体"（避免把"这是什么意思"当实体） */
const STOP_SUBJECT = new Set(['什么', '意思', '东西', '这个', '那个', '它', '他', '她', '我们', '你', '我', '这', '那']);

/**
 * 判断是否是"问一个与课程无关的实体"（如"开心超人是什么""奥特曼是什么"）。
 * 用途：这类问题即便学生开着联网，也不该触发**课程动作**（推进进度/出题/取讲义），
 * 而应简短说明与课程无关并引导回来。
 * @returns {string|null} 课外主体词（无则 null）
 */
function foreignSubject(message, opts = {}) {
  const m = String(message || '').match(ASK_ABOUT_RE);
  if (!m) return null;
  const subj = String(m[1] || m[2] || '').trim();
  if (!subj) return null;
  const toks = tokenize(subj).filter((t) => !STOP_SUBJECT.has(t));
  if (!toks.length) return null;
  // 复用课程边界判定：主体在课程/领域内 → 不是课外实体
  return checkWebScope(subj, opts).allowed ? null : subj;
}

/** 给模型/学生的解释文案（拒绝时用） */
function denyHint(reason) {
  if (reason === 'off-topic') {
    return '这个问题和《Python 编程入门》课程无关，我不会为它联网检索。我们可以继续课程内容，比如变量、循环、函数这些知识点。';
  }
  return '这个问题我看不出和本课程/编程学习有关，所以没有联网检索。如果你是想查某个 Python 用法或报错，可以把具体代码或报错发我，我来帮你查。';
}

/* -------- 每轮"是否允许联网"的上下文（AsyncLocalStorage，供 MCP 工具层硬拦截） -------- */
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

/** 包裹一轮：携带本轮是否允许联网检索 */
function runWithWebScope(allowed, fn) {
  return als.run({ webAllowed: !!allowed }, fn);
}
/** 当前轮是否允许联网（无上下文时视为允许，保持既有行为不突变） */
function isWebAllowedNow() {
  const s = als.getStore();
  return s ? s.webAllowed !== false : true;
}

module.exports = {
  checkWebScope, foreignSubject, denyHint, invalidate, tokenize,
  runWithWebScope, isWebAllowedNow,
  OFF_TOPIC, DOMAIN,
};
