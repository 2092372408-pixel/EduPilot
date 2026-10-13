/**
 * agents.js — 多 Agent 角色注册表
 * ------------------------------------------------------------
 * 从"单 Agent"升级为"多 Agent 编排"：
 * 四个专用角色与一个通用教育角色共用同一份【知识库 + 状态机 + 会话记忆】，
 * 差异在于 ①人格提示词 ②工具白名单（能力边界）。
 *
 *   协调者 Coordinator ──→ 意图路由
 *     ├── 预习 Agent（Preview）：提问引导，激发好奇，不直接给答案
 *     ├── 学习 Agent（Learn）：讲解老师，先类比再原理，给示例
 *     ├── 复习 Agent（Review）：考核教练，总结 + 错题重练 + 测试
 *     └── 通用教育 Agent（General）：普通问答与未知意图兜底
 *
 * 扩展新角色：往 AGENTS 表加一条配置即可（提示词、工具、映射）。
 */

const { tools } = require('./tools');
const mcpBridge = require('../mcp/bridge'); // MCP 工具来源（与内置工具同构，合入同一张工具表）

const TOOL_NAMES = Object.keys(tools);

/** 各角色的工具白名单（能力边界：Agent 只能调用自己清单内的工具）
 *  联网能力不再有内置工具：统一走 MCP 检索类工具（mcp__tavily__tavily_search /
 *  mcp__devsites__search_dev / mcp__devsites__github_search），由 mcpBridge 按角色合入。 */
const TOOL_WHITELIST = {
  general: ['search_knowledge_base', 'conversation_search'],
  coordinator: ['get_course_overview', 'get_learning_progress', 'recommend_next', 'conversation_search'],
  // preview 需要 check_answer：预习自测出题后学生作答必须有判分反馈
  // （判分逻辑本身不会因预习自测而授予掌握，见 tools.check_answer / state.completeQuiz）
  preview: ['get_course_overview', 'get_knowledge_point', 'search_knowledge_base', 'conversation_search', 'generate_quiz', 'check_answer', 'update_progress', 'recommend_next'],
  learn: ['get_course_overview', 'get_knowledge_point', 'search_knowledge_base', 'conversation_search', 'generate_quiz', 'check_answer', 'update_progress', 'recommend_next'],
  review: ['get_knowledge_point', 'search_knowledge_base', 'conversation_search', 'generate_quiz', 'check_answer', 'update_progress', 'recommend_next'],
};

/**
 * 动态课程沿用相同的教学、测验与门禁工具，教材内容按 courseId 隔离。
 */
const DYNAMIC_TOOLS = {
  general: ['search_knowledge_base', 'conversation_search'],
  coordinator: [...TOOL_WHITELIST.coordinator, 'search_knowledge_base'],
  preview: [...TOOL_WHITELIST.preview, 'get_learning_progress'],
  learn: [...TOOL_WHITELIST.learn, 'get_learning_progress'],
  review: [...TOOL_WHITELIST.review, 'get_learning_progress'],
};

const AGENTS = {
  general: {
    id: 'general',
    name: '通用教育 Agent',
    emoji: '🎓',
    role: 'general',
    description: '通用教育问答：解释跨学科问题、提供学习建议，不推进课程阶段',
    person: '你是一位耐心、专业的通用教育老师。直接回答学生的问题，用清晰的解释、例子和必要的追问帮助理解，不局限于当前课程。',
    tools: () => TOOL_WHITELIST.general,
  },
  coordinator: {
    id: 'coordinator',
    name: '协调者',
    emoji: '🧭',
    role: 'coordinator',
    description: '总览课程、推荐学习路径、引导对话',
    person: '你是一个耐心的学习规划师。学生不确定学什么时，你介绍课程、推荐下一步。',
    tools: () => TOOL_WHITELIST.coordinator,
  },
  preview: {
    id: 'preview',
    name: '预习 Agent',
    emoji: '🔎',
    role: 'preview',
    description: '预习引导：用提问激发思考，给知识地图，不直接给答案',
    person: '你是一个善于启发式提问的预习引导师。你绝不一上来就讲答案，而是用问题、类比和知识地图让学生先建立好奇心和整体印象。预习阶段允许学生答错。',
    tools: () => TOOL_WHITELIST.preview,
  },
  learn: {
    id: 'learn',
    name: '学习 Agent',
    emoji: '📖',
    role: 'learn',
    description: '学习讲解：先打比方再讲原理，给代码示例，指出常见误区',
    person: '你是一个讲课生动的讲解老师。讲解节奏：先生活类比→再讲原理→给可运行示例→点出常见误区→追问确认。学生不懂时换一种类比再讲。',
    tools: () => TOOL_WHITELIST.learn,
  },
  review: {
    id: 'review',
    name: '复习 Agent',
    emoji: '🔁',
    role: 'review',
    description: '复习巩固：知识速览 + 错题优先重练 + 掌握度评估',
    person: '你是一个严格的考核教练。复习流程：知识速览→错题优先重测→逐题点评→总结正确率→标记掌握。答错不可怕，你要让学生明白为什么错。',
    tools: () => TOOL_WHITELIST.review,
  },
};

/**
 * 意图 → Agent 映射（协调者路由表）。
 * answer（判分）按当前测验模式分流：随堂练习→学习Agent，复习测试→复习Agent。
 * chat 中的课程规划由协调者处理；其他 chat 与未知意图均交给通用教育 Agent。
 * @returns {string} agent id
 */
function routeIntent(intent, learning, userMessage = '') {
  switch (intent) {
    case 'course_overview':
    case 'progress':
      return 'coordinator';
    case 'preview':
      return 'preview';
    case 'learn':
      return 'learn';
    case 'quiz':
      return 'learn'; // 随堂练习归属学习 Agent
    case 'practice':
      return 'learn'; // 针对性练习（薄弱点多练）同样由学习 Agent 带练
    case 'review_quiz':
      return 'review'; // 复习测试归属复习 Agent
    case 'review':
      return 'review';
    case 'answer': {
      const mode = learning.currentQuiz && learning.currentQuiz.mode;
      return mode === 'review' ? 'review' : 'learn';
    }
    case 'chat': {
      const PLANNING = /从哪(开始|学起|入手)|先学(什么|哪|点)|该学什么|学什么好|怎么安排|如何安排|学习(计划|顺序|路线|节奏)|推荐(学|一下|个)|下一步(学|做什么)|接下来(学|做什么)|有什么建议|该怎么学|\b(where (?:should i|to) start|learning plan|what should i learn)\b/i;
      if (PLANNING.test(userMessage)) return 'coordinator';
      return 'general';
    }
    default:
      return 'general';
  }
}

/**
 * 根据 Agent 角色取可用工具对象（白名单；dynamic=true 时用动态课受限工具集）。
 * MCP 工具（`mcp__<server>__<tool>`）在此合入同一张工具表 —— 白名单/预算/审计三套机制自动复用。
 * MCP Server 未连接或该角色未授权时返回空，不影响内置工具（deny-by-default + 失败降级）。
 * @param {object} [opts] { webMode } —— webMode='off' 时隐藏联网检索类 MCP 工具（学生选择本次不联网）
 */
function toolsForAgent(agentId, dynamic = false, opts = {}) {
  const cfg = AGENTS[agentId];
  if (!cfg) return {};
  const whitelist = dynamic ? DYNAMIC_TOOLS[agentId] : cfg.tools();
  const result = {};
  for (const n of whitelist || []) if (tools[n]) result[n] = tools[n];
  try {
    Object.assign(result, mcpBridge.toolsForAgent(agentId, opts));
  } catch (e) {
    console.warn('[mcp] 工具合入失败（已忽略，不影响内置工具）:', e.message);
  }
  return result;
}

module.exports = { AGENTS, routeIntent, toolsForAgent, TOOL_WHITELIST };
