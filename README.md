<p align="right"><strong>简体中文</strong> | <a href="README_en.md">English</a></p>

<p align="center"><img src="public/logo-mark.png" alt="EduPilot" width="72" height="72" /></p>

<h1 align="center">EduPilot · AI 学习向导</h1>

<p align="center"><strong>把你的教材，变成能讲、能练、能陪你学下去的 AI 课程。</strong></p>

<p align="center">导入中英文资料，按章节学习，在讲解、练习和复习之间自然衔接。<br />Windows / macOS · 中英文界面 · 内置演示课无需密钥</p>

<p align="center">
  <a href="https://github.com/2092372408-pixel/EduPilot/releases/latest"><img src="https://img.shields.io/badge/Release-v1.1.4-2563eb" alt="最新版 v1.1.4" /></a>
  <a href="https://github.com/2092372408-pixel/EduPilot/releases/latest/download/EduPilot-Windows-Installer.zip"><img src="https://img.shields.io/badge/Windows-x64-2ea44f?logo=windows&logoColor=white" alt="下载 Windows 安装包" /></a>
  <a href="https://github.com/2092372408-pixel/EduPilot/releases/latest/download/EduPilot-macOS-AppleSilicon-Installer.tar.gz"><img src="https://img.shields.io/badge/macOS-Apple_Silicon-111111?logo=apple&logoColor=white" alt="下载 Mac M 系列芯片安装包" /></a>
  <a href="https://github.com/2092372408-pixel/EduPilot/releases/latest/download/EduPilot-macOS-Intel-Installer.tar.gz"><img src="https://img.shields.io/badge/macOS-Intel-555555?logo=apple&logoColor=white" alt="下载 Mac Intel 安装包" /></a>
</p>

<p align="center"><a href="#download">开始体验</a> · <a href="#demo">看看学习过程</a> · <a href="#features">核心亮点</a> · <a href="#faq">常见问题</a></p>

<a id="workspace"></a>

<img src="docs/screenshots/study-ready-zh.jpg" alt="真实学习界面：导入教材生成章节课程，在对话中完成预习检测题卡" width="100%" />

<a id="download"></a>

## 三步，开始你的第一节课

1. **下载并解压**上方对应平台的安装包。Mac M 系列芯片请选择 Apple Silicon。
2. **双击安装**：Windows 打开 EduPilot/install.bat；macOS 打开 EduPilot/install.command。安装后创建带图标的桌面入口，并打开学习页面。
3. **先体验，再导入**：无需密钥体验内置 Python 演示课；在设置中接入模型后，上传自己的教材，开始新的课程。

以后双击桌面 **EduPilot** 图标即可开始学习。关闭最后一个 EduPilot 页面后，后台服务会自动退出；刷新或切换到练习、报告页面可以继续使用。学习记录保存在本机，下次打开接着学。

首次打开有按钮指向式教程，带你认识选课、上传、提问、错题本和报告。可以跳过，也可以从顶部 **教程** 重新查看。macOS 首次打开若出现系统确认，请在 Finder 中右键选择“打开”。

<a id="demo"></a>

## 从一份教材，到一次完整学习

导入资料 → 自动成课 → 预习检测 → 学习与练习 → 查看学习报告。以下动图展示真实操作的关键步骤。

<details>
<summary>展开查看真实界面的学习演示</summary>

<img src="docs/demos/learning-journey-zh.gif" alt="学习演示：教材导入、章节课程、配套练习、答题反馈与学习报告" width="100%" />

</details>

<a id="features"></a>

## 让自主学习更连贯的三个理由

### 自己的教材，就是自己的课程

导入中英文 PDF、Word、PowerPoint、Markdown、TXT 或 JSON，自动按章节整理为知识点讲义、示例、易错点和配套选择题。准备好后，自己的资料也能像演示课一样按知识点开始学习。

讲解和题目围绕教材组织，遇到疑问可以结合原文查找与追问。补充资料时复用已有内容，让自己的课程持续完善。

### 预习 → 学习 → 复习，每一步都有反馈

先用预习自测发现不熟悉的地方，跟随讲解建立理解，再通过练习检验，最后回来复习。题卡就在对话里，选择答案即可查看反馈与解释。

每个知识点分别记录阶段与检测结果。错题本方便回顾和重练，学习报告汇总进度、待完成检测与复习安排，帮你决定下一步。

### 记住目标和进度，下次学习接得上

告诉学伴你的基础、目标和偏好，例如“我刚开始学 Python，希望多用生活中的例子”。有用的信息可以成为后续讲解的参考，课程进度、对话和练习记录会保留在自己的电脑上。

你可以跟着课程一步步走，也可以随时提出其他学习问题。每次提问、练习和回顾，都为下一次学习留下起点。

<details>
<summary>还有这些顺手的能力</summary>

- **Python 动手实践**：在代码区写代码、运行、提交并查看反馈，卡住时向做题助手请求提示；学完内置课程后可以挑战综合测验。
- **带着材料提问**：附上图片或文档一起讨论；图片提问请选择支持图片输入的模型。
- **按需联网**：开启联网搜索，补充查找与学习相关的资料。
- **适应你的习惯**：切换中英文界面、调整字号，选择自己顺手的模型服务。

</details>

<a id="api-keys"></a>

## 接入你喜欢的模型

打开 **设置 → LLM 模型 → 配置供应商与密钥**，选择供应商，填入 API Key，选择模型并保存。开放问答、自己的教材讲义与题目生成使用所选模型，费用由服务商收取。

支持 DeepSeek、Qwen、OpenAI、GLM、Kimi 等服务及兼容接口。联网搜索可在 **设置 → 联网搜索 · Tavily** 中填写 [Tavily Key](https://app.tavily.com/home)，按需开启。

<details>
<summary>查看各供应商的官方密钥入口</summary>

| 供应商 | 官方入口 |
| --- | --- |
| DeepSeek | [创建 API Key](https://platform.deepseek.com/api_keys) |
| 阿里云百炼 · Qwen | [控制台](https://bailian.console.aliyun.com/) |
| OpenAI | [创建 API Key](https://platform.openai.com/api-keys) |
| 智谱 · GLM | [创建 API Key](https://open.bigmodel.cn/usercenter/apikeys) |
| Moonshot · Kimi | [创建 API Key](https://platform.kimi.com/console/api-keys) |
| 硅基流动 | [创建 API Key](https://cloud.siliconflow.cn/account/ak) |
| 火山方舟 · 豆包 | [控制台](https://console.volcengine.com/ark) |
| OpenRouter | [创建 API Key](https://openrouter.ai/keys) |

</details>

<a id="faq"></a>

## 你可能想知道

**没有 API Key，可以先用吗？**

可以。内置 Python 演示课无需密钥，适合熟悉学习流程。真实开放问答和自己的教材成课需要接入模型，联网搜索使用单独的 Tavily Key。

**中英文教材都支持吗？**

支持中英文内容及界面。PDF 请使用可提取文字的版本，扫描件需要先转成文字。

**资料和学习记录存在哪里？**

教材解析在本机完成，课程、对话和学习记录保存在自己的电脑上。使用在线模型或联网功能时，相关问题、教材片段或附件会发送到你选择的服务商。

**需要额外安装环境吗？**

安装包自带应用运行环境，演示课和普通文档解析可以直接体验。Python 代码实践需要安装 Python；可选的本地语义检索需要额外配置 Python 与向量模型，未配置时使用关键词检索。

**关掉网页就退出了吗？刷新会不会退出？**

从桌面图标启动时，关闭最后一个 EduPilot 页面后约 15 秒自动停服；保留任一工作台、练习或报告页面即可继续使用，刷新会重新连接。已接受的处理任务会有一小段保存时间。下次双击桌面图标即可重新打开；需要立即停止时，也可以使用安装目录里的 stop.bat 或 stop.command。

**升级会保留之前的学习吗？**

用新版安装包更新同一用户的安装目录，会保留模型配置、课程和学习数据。升级前关闭 EduPilot 页面，让旧服务退出后再安装。

## 我们的初心

我们希望学习更科学、更连贯，也把主动权交还给每一个人。清晰的目标、探索、反馈与复习，让学生能够主动提问、尝试和回顾，再决定下一步。

学习是一条贯穿一生的路径。EduPilot 希望让过去的理解成为今天的起点，让每一次困惑、练习和进步，都能支持明天的探索。

> **学自己想学的，做自己想做的。你的每一步，都值得被记录。**

<a id="feedback"></a>

有使用建议、想学的课程或遇到问题，欢迎通过 [GitHub Issues](https://github.com/2092372408-pixel/EduPilot/issues) 或 [邮箱](mailto:qiuyanzihan2004@gmail.com) 告诉我们。

© 2026 **Qiu Yanzihan** · 个人与非商业使用请参阅 [使用许可](LICENSE)；商业合作请联系作者。第三方材料的条款见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。
