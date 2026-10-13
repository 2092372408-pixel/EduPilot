const { AsyncLocalStorage } = require('node:async_hooks');
const messages = require('../public/ui-en');
const zhCourse = require('./data/course').course;
const enCourse = require('./data/course_en').course;
const context = new AsyncLocalStorage();
const content = new Map();
const canonical = new Map();
const questions = new Map();

// Built-in content has identical topic IDs and option ordering in both languages.
function pair(zh, en) {
  if (typeof zh === 'string' && typeof en === 'string') {
    if (zh !== en && !/[\u3400-\u9fff]/.test(zh)) return;
    content.set(zh, en);
    canonical.set(en, zh);
  } else if (zh && en && typeof zh === 'object') {
    if (zh.q && en.q) questions.set(zh.q, en);
    for (const key of Object.keys(zh)) pair(zh[key], en[key]);
  }
}
pair(zhCourse, enCourse);
const problemTranslations = [
  ['Swap variables', 'Given `a = 1` and `b = 2`, swap their values so that `a == 2` and `b == 1`. You may use a temporary variable.', 'a = 1\nb = 2\n# Write the swap here\n', ['After swapping: a=2, b=1', 'a and b are different']],
  ['Inspect a type', 'Define `x = 3.14`. Print its type name using `type(x).__name__`, then its integer conversion on the next line.', 'x = 3.14\n# Write your code here\n', ['x is a float', 'Converting to an integer gives 3']],
  ['Odd or even', 'Given `n = 7`, use `if/else` to print "even" when n is even, or "odd" when it is odd.', 'n = 7\n# Write your code here\n', ['7 is odd']],
  ['Sum from 1 to 100', 'Use a `for` loop to calculate `1 + 2 + ... + 100`. Store the result in `total` and print it.', '# Write your code here\ntotal = 0\n', ['The sum is 5050']],
  ['An addition function', 'Define `add(a, b)` to return `a + b`. Call `add(3, 4)` and print the result.', '# Write your code here\n', ['add(3, 4) returns 7', 'add(10, -2) returns 8']],
  ['Maximum of a list', 'Given `nums = [3, 8, 1, 6, 9, 2]`, find the largest value without using `max()`. Store it in `max_val` and print it.', 'nums = [3, 8, 1, 6, 9, 2]\n# Write your code here\n', ['The maximum is 9']],
  ['Define a Dog class', 'Define a class `Dog`. Its constructor takes `name` and stores it in `self.name`. Its `bark()` method returns the string "\\u6c6a\\u6c6a" (use these Python Unicode escapes). Create `d = Dog("Rover")` and store `d.bark()` in `sound`.', '# Write your code here\n', ['The name attribute matches the input', 'bark() returns "\\u6c6a\\u6c6a"']],
];
require('./coding/problems').PROBLEMS.forEach((problem, i) => {
  const [title, description, starterCode, descriptions] = problemTranslations[i];
  pair(problem.title, title); pair(problem.description, description); pair(problem.starterCode, starterCode);
  problem.testCases.forEach((test, n) => pair(test.desc, descriptions[n]));
});
Object.entries({
  '入门': 'Beginner', '进阶': 'Intermediate',
  'DeepSeek 深度求索': 'DeepSeek', '阿里云百炼（通义千问 Qwen）': 'Alibaba Cloud Model Studio (Qwen)',
  '智谱 GLM': 'Zhipu GLM', '硅基流动 SiliconFlow': 'SiliconFlow', '火山方舟（豆包 Doubao）': 'Volcengine Ark (Doubao)',
  'OpenRouter（聚合）': 'OpenRouter', '自定义 OpenAI 兼容服务': 'Custom OpenAI-compatible service',
  'Flash 支持文字与图片；V4 Pro 仅支持文字。模型权限以账户为准。': 'Flash accepts text and images; V4 Pro accepts text only. Availability depends on your account.',
  '模型最全（含 Qwen / Kimi / GLM 等托管版）；注意密钥与区域绑定': 'Hosts Qwen, Kimi, GLM, and other models. API keys are region-specific.',
  'GLM 视觉版与文本版分别标注；注意服务地址包含 /paas/v4。': 'Vision and text-only GLM models are labeled separately. The service URL includes /paas/v4.',
  '当前 Kimi 模型支持文字、图片与视频；旧版 Moonshot V1 已退役。': 'Current Kimi models accept text, images, and video. Moonshot V1 has been retired.',
  '提供托管模型；请刷新账户模型列表，权限与能力以所选模型为准。': 'Hosts multiple models. Refresh your account model list to check available models and their capabilities.',
  '可选择官方 Model ID；私有推理接入点需刷新账户列表，能力单独确认。': 'Choose an official model ID. Refresh your account list for private inference endpoints; their capabilities need separate verification.',
  '推理型模型（o 系列 / gpt-5 系）可能限制 temperature 且需 max_completion_tokens': 'Reasoning models may restrict temperature and require max_completion_tokens.',
  '模型输入能力来自 OpenRouter 官方模型目录；一个 Key 可访问多家模型。': 'Input capabilities come from the official OpenRouter model catalog. One key accesses multiple providers.',
  '填写兼容服务地址后刷新模型列表，再从下拉菜单选择模型。': 'Enter your compatible service URL, refresh its model list, then choose a model from the dropdown.',
  '协调者': 'Coordinator', '预习 Agent': 'Preview agent', '学习 Agent': 'Learning agent', '复习 Agent': 'Review agent', '通用教育 Agent': 'General education agent',
  '按你最近的薄弱点挑的': 'Selected based on topics that need more practice',
  '消息不能为空': 'Enter a message first.', '内部错误': 'Internal server error',
  '代码不能为空': 'Enter some code first.', '题目不存在': 'Problem not found.',
  '需要 API 认证：请提供 EDUOWL_AUTH_TOKEN': 'API authentication required. Provide EDUOWL_AUTH_TOKEN.',
  '没有进行中的考试': 'No exam is in progress.',
  '内置演示引擎（Mock 模式）': 'Built-in demo engine (offline mode)',
  '尚未配置 API Key —— 点击右上角「配置模型」接入真实大模型': 'No API key configured. Choose Model to connect a provider.',
  '当前使用内置演示引擎（可随时配置真实模型）': 'Using offline demo lessons. Connect a model anytime.',
  '请填写服务地址（base_url）': 'Enter a service URL (base_url).',
  '服务地址需以 http:// 或 https:// 开头': 'The service URL must start with http:// or https://.',
  '官方资料确认该模型不支持图片输入': 'Official documentation confirms that this model does not accept images.',
  'API Key 格式无效': 'The API key format is invalid.',
  '服务地址或模型名格式无效': 'The service URL or model name format is invalid.',
  '单条消息最多附加 8 个文件': 'Attach up to 8 files per message.',
  '附件不存在或不属于当前会话，请重新上传': 'An attachment is missing or belongs to another conversation. Upload it again.',
  '图片文件已丢失，请重新上传': 'The image file is missing. Upload it again.',
  '不支持的附件格式（支持图片、md/txt/json/docx/pdf/pptx）': 'Unsupported attachment format. Use images, md, txt, json, docx, pdf, or pptx.',
  '附件内容为空': 'The attachment is empty.',
  '附件未提取出可用文字': 'No readable text could be extracted from the attachment.',
  '文档解析为空：可能是扫描版 PDF（无文字层）或加密文档，请改用文字版后重试': 'No text could be extracted. The document may be scanned or encrypted. Use a document with selectable text and retry.',
  '规范化后无有效内容': 'No usable content remained after processing.',
  '内置课程不可删除': 'Built-in courses cannot be deleted.',
  '未指定要删除的错题': 'Choose a mistake to delete.',
  '未找到该知识点': 'Topic not found.',
  '课程暂无可用知识点，请检查课程数据': 'This course has no available topics. Check the course data.',
  '未知测验模式': 'Unknown quiz mode.',
  '该小节还没有练习题': 'No practice questions are available for this section yet.',
  '该知识点暂无题目': 'No questions are available for this topic yet.',
  '无法匹配题目': 'The question could not be matched.',
  '未知学习阶段': 'Unknown learning stage.',
  '当前处于离线演示模式，请先在设置中选择支持图片输入的模型': 'Offline demo mode cannot process images. Choose a model with image input in Settings first.',
  '请填写 API Key': 'Enter an API key.', '请先填写 API Key': 'Enter an API key first.',
  'API Key 无效或已过期，请到平台重新申请后填入': 'The API key is invalid or expired. Obtain a new key from your provider.',
  '该 Key 无权限访问此模型（可能是未开通或欠费）': 'This key cannot access the model. Check model access and your account balance.',
  '服务地址或模型名不正确（请检查 base_url 是否包含 /v1 之类的版本路径）': 'Incorrect service URL or model name. Check the version path in base_url, such as /v1.',
  '请求过于频繁或额度不足，请稍后再试或检查账户余额': 'Rate limit or quota exceeded. Try later or check your account balance.',
  '平台服务端暂时异常，请稍后重试': 'The provider is temporarily unavailable. Try again later.',
  '平台返回内容无法解析（期望 JSON）': 'The provider returned an invalid response; JSON was expected.',
  '请求超时（20s）': 'Request timed out (20 seconds)', '请求超时（30s）': 'Request timed out (30 seconds)',
  '尚未解锁期末大实践': 'The final challenge is still locked.', '当前课程没有可用题目': 'No questions are available for this course.',
  '缺少用户标识': 'Missing user ID.', '昵称不能为空（1~20 字）': 'Enter a nickname (1–20 characters).', '缺少 uid': 'Missing user ID.',
  '会话不存在': 'Session not found.', '课程名称需为 1~60 字': 'Course names must contain 1–60 characters.',
  '仅可修改用户上传的课程名称': 'Only uploaded courses can be renamed.',
  '配置接口仅允许本机访问（检测到远程请求）': 'Model settings are available only from the server machine. A remote request was detected.',
  '未知的配置接口': 'Unknown configuration endpoint.',
  '联网配置仅允许本机访问（检测到远程请求）': 'Web search settings are available only from the server machine. A remote request was detected.',
  '未知的联网配置接口': 'Unknown web search settings endpoint.',
  'Tavily API Key 过长': 'The Tavily API key is too long.',
  'Tavily API Key 格式无效': 'The Tavily API key format is invalid.',
  '开启联网搜索前请先填写 Tavily API Key': 'Enter a Tavily API key before enabling web search.',
  '缺少 filename（query 参数或 X-Filename 请求头）': 'Missing filename in the query or X-Filename header.',
  '请求内容超过大小上限（1 MB）': 'Request exceeds the 1 MB size limit.', '请求内容必须是有效的 JSON 对象': 'The request body must be a valid JSON object.',
  '请求已中断': 'Request interrupted.', '缺少文件扩展名': 'Missing file extension.', '文件内容为空': 'The file is empty.',
  '（模型未生成内容，请再试一次）': 'The model returned no content. Please try again.',
  '（模型未给出回复）': 'The model returned no response.',
  '⚠️ 已达到最大推理步数，请说得更具体一些，或者换个问法试试。': '⚠️ The reasoning limit was reached. Try a more specific question or rephrase it.',
  '代码包含不允许的操作（文件/系统/网络等），学习沙箱已拦截': 'The learning sandbox blocked a restricted file, system, or network operation.',
  '代码未通过安全预检，学习沙箱已拦截': 'The learning sandbox blocked code that failed its safety check.',
  '代码未通过安全预检': 'Code did not pass the safety check.', '安全预检写入失败': 'Unable to send code to the safety checker.',
  '安全预检未返回有效结果（通常是没有可用的 Python 解释器；请安装 Python 3 或设置 PYTHON_BIN）': 'The safety checker returned no valid result. Install Python 3 or configure PYTHON_BIN.',
}).forEach(([zh,en]) => pair(zh,en));
const english = () => context.getStore() === 'en';
const errorPatterns = [
  [/^当前模型「(.*?)」的图片能力尚未确认，请先在设置中点击“测试图片能力”$/s, (_, model) => `Image support for model "${model}" is unconfirmed. Use "Test image support" in Settings first.`],
  [/^附件过大：超过 (.*?)MB 上限$/, (_, limit) => `The attachment exceeds the ${limit} MB limit.`],
  [/^JSON 解析失败：(.*)$/s, (_, detail) => `Invalid JSON: ${detail}`],
  [/^不支持的格式：(.*?)（支持 \.md\/\.txt\/\.json\/\.docx\/\.pdf\/\.pptx）$/, (_, ext) => `Unsupported format ${ext}. Use md, txt, json, docx, pdf, or pptx.`],
  [/^上游 LLM 响应超时（>(\d+)s）$/, (_, seconds) => `The model response timed out (over ${seconds} seconds).`],
  [/^LLM API 错误 (\d+): (.*)$/s, (_, status, detail) => `LLM API error ${status}: ${detail}`],
  [/^当前模型「(.*?)」不支持图片输入，请在设置中选择支持图片输入的模型后重试$/s, (_, model) => `Model "${model}" does not accept images. Choose a model with image input in Settings and retry.`],
  [/^语法错误：(.*)（第 (\d+) 行）$/s, (_, message, line) => `Syntax error: ${message} (line ${line})`],
  [/^代码包含不允许的操作：(.*)$/s, (_, operations) => 'Restricted operations: ' + operations.split('、').map(op => op.replace(/^调用 /, 'call ').replace(/^访问 /, 'access ').replace(/^引用 /, 'reference ').replace('相对导入', 'relative import').replace('字符串中包含危险 dunder 名称', 'restricted dunder name in a string')).join(', ')],
  [/^预检异常：(.*)$/s, (_, detail) => `Safety check failed: ${detail}`],
  [/^(课程不存在|要追加的课程不存在): (.*)$/s, (_, kind, id) => `Course not found: ${id}`],
  [/^知识点不存在: (.*)$/s, (_, id) => `Topic not found: ${id}`],
  [/^代码超过 (\d+) 字符上限$/, (_, n) => `Code exceeds the ${n}-character limit.`],
  [/^文件过大：超过 (\d+)MB 上限（当前 (.*?)MB）。请压缩或拆分后重新上传$/, (_, limit, size) => `File exceeds the ${limit} MB limit (current size: ${size} MB). Compress or split it and retry.`],
  [/^不支持的文件格式 \.(.*?)（支持：docx \/ pdf \/ pptx \/ md \/ json \/ txt）$/, (_, ext) => `Unsupported file type .${ext}. Use docx, pdf, pptx, md, json, or txt.`],
  [/^解析内容过大（约 (\d+) 万字，超过 (\d+) 万上限）。请拆分文件后重新上传$/, (_, size, limit) => `Parsed content is too large (about ${Number(size)*10000} characters; limit ${Number(limit)*10000}). Split the file and retry.`],
  [/^(写入 \.env 失败|连接失败|档案保存失败|安全预检不可用|沙箱创建失败|脚本写入失败|沙箱启动失败)[:：] ?(.*)$/s, (_, kind, detail) => `${({ '写入 .env 失败': 'Unable to save .env', '连接失败': 'Connection failed', '档案保存失败': 'Unable to save profile', '安全预检不可用': 'Safety checker unavailable', '沙箱创建失败': 'Unable to create sandbox', '脚本写入失败': 'Unable to write script', '沙箱启动失败': 'Unable to start sandbox' })[kind]}: ${translate(detail)}`],
  [/^平台返回错误 (\d+)：(.*)$/s, (_, status, detail) => `Provider error ${status}: ${detail}`],
  [/^真实 LLM · (.*?) 引擎$/, (_, engine) => `Connected model · ${engine}`],
  [/^当前使用真实 LLM（(.*?) 引擎自主调用工具）$/, (_, engine) => `Using a connected model with ${engine} tool calls.`],
];
function translate(text) {
  if (!english()) return text;
  const exact = content.get(text) ?? messages[text];
  if (exact !== undefined) return exact;
  if (typeof text === 'string') for (const [pattern, replacement] of errorPatterns) if (pattern.test(text)) return text.replace(pattern, replacement);
  return text;
}
const canonicalQuestion = text => canonical.get(text) ?? text;

// Only application-owned display fields are localized. Messages, uploaded source
// text, filenames, nicknames, user answers, and program output retain their content.
const displayFields = new Set(['title', 'courseTitle', 'kpTitle', 'chapter', 'q', 'question', 'options', 'explanation',
  'desc', 'difficulty', 'description', 'starterCode', 'phaseLabel', 'name', 'label', 'tip', 'error', 'hint', 'note', 'reason']);
const preserveFields = new Set(['messages', 'memories', 'summary', 'nickname', 'userAnswer', 'code', 'stdout', 'stderr', 'content', 'text']);
function display(value, field = '') {
  if (!english() || preserveFields.has(field)) return value;
  if (typeof value === 'string') return displayFields.has(field) ? translate(value) : value;
  if (Array.isArray(value)) return value.map(item => display(item, field));
  if (!value || typeof value !== 'object') return value;
  if (value.dynamic === true || String(value.id || '').startsWith('user-')) return value;
  // Keep each question's options and explanation together; shared option text
  // must not borrow a translation from another question.
  const question = questions.get(value.q || value.question);
  if (question) value = {
    ...value,
    [value.q ? 'q' : 'question']: question.q,
    ...(Array.isArray(value.options) ? { options: question.options } : {}),
    ...(value.explanation !== undefined ? { explanation: question.explanation } : {}),
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, display(item, key)]));
}
function runRequest(req, fn) {
  const query = new URLSearchParams(String(req.url || '').split('?')[1] || '');
  const lang = query.get('lang') || String(req.headers['accept-language'] || '').split(',')[0];
  return context.run(/^en(?:-|$)/i.test(lang) ? 'en' : 'zh', fn);
}
module.exports = { english, translate, display, runRequest, canonicalQuestion, content };
