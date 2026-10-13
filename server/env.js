/**
 * env.js — 极简 .env 加载器（零依赖）
 * ------------------------------------------------------------
 * 作用：启动时自动读取项目根目录的 .env 文件，注入 process.env。
 * 为什么不用 setx / 系统环境变量：
 *   1. 项目级配置隔离，不污染用户系统（本项目的 401 教训：环境里残留
 *      一个失效的 OpenRouter Key，导致默认请求全被它劫持）；
 *   2. .env 可提交 .env.example 模板、可团队共享；
 *   3. 这是 12-factor 应用的标准做法。
 * 优先级规则：LLM_ 开头的配置以 .env 为准（覆盖环境残留）；
 * 其他变量仅在系统未设置时写入。
 *
 * 配置文件位置可用 EDUOWL_ENV_FILE 覆盖（自动化测试用临时文件隔离，
 * 避免并行测试互相读写同一个 .env 而串号）。
 *
 * 【补充】"以 .env 为准" 必须包含"清掉 .env 里没有的 LLM_ 残留"：
 *   仅做到"覆盖"无法处理 .env 里**没有**该键、而系统环境里留着旧 Key 的情况——
 *   此时旧 Key 会静默生效：用户在配置向导里看不到异常，却每轮对话都失败
 *   （本机 Windows 用户环境里就实测残留过一个失效的 OpenRouter Key）。
 *   故：只要 .env 里存在任意 LLM_ 配置，就视为"本项目已自行管理 LLM 配置"，
 *   把 .env 未声明的 LLM_* 从环境里清掉。
 *   （.env 完全没有 LLM_ 配置时不清理，保留 `LLM_MODE=mock npm start` 这类临时覆盖。）
 */

const fs = require('fs');
const path = require('path');

function loadEnv() {
  // 配置文件位置可覆盖：自动化测试需要隔离自己的 .env，
  // 否则并行跑的测试会互相读到对方的临时配置（并发读写同一文件会串号）。
  const envFile = process.env.EDUOWL_ENV_FILE || path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envFile)) return;

  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  const declaredLLM = new Set(); // .env 里声明过的 LLM_ 键
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue; // 跳过空行与注释
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    // 去掉引号包裹
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key.startsWith('LLM_')) declaredLLM.add(key);
    // LLM 配置以 .env 为准；其余仅当系统未设置时写入
    if (key.startsWith('LLM_') || process.env[key] === undefined) {
      process.env[key] = val;
    }
  }

  // .env 已管理 LLM 配置 → 清掉环境里遗留的、.env 未声明的 LLM_ 键（见文件头说明）
  if (declaredLLM.size) {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('LLM_') && !declaredLLM.has(k)) delete process.env[k];
    }
  }
}

loadEnv();
module.exports = { loadEnv };
