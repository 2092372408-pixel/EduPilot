<p align="right"><a href="README.md">简体中文</a> | <strong>English</strong></p>

<p align="center"><img src="public/logo-mark.png" alt="EduPilot" width="72" height="72" /></p>

<h1 align="center">EduPilot · Your AI Learning Companion</h1>

<p align="center"><strong>Turn your materials into an AI course—with lessons, practice and a companion to learn alongside you.</strong></p>

<p align="center">Import Chinese or English materials and move naturally between explanations, practice and review.<br />Windows / macOS · English and Chinese · Try the built-in demo without a key</p>

<p align="center">
  <a href="https://github.com/2092372408-pixel/EduPilot/releases/latest"><img src="https://img.shields.io/badge/Release-v1.1.4-2563eb" alt="Latest release v1.1.4" /></a>
  <a href="https://github.com/2092372408-pixel/EduPilot/releases/latest/download/EduPilot-Windows-Installer.zip"><img src="https://img.shields.io/badge/Windows-x64-2ea44f?logo=windows&logoColor=white" alt="Download for Windows" /></a>
  <a href="https://github.com/2092372408-pixel/EduPilot/releases/latest/download/EduPilot-macOS-AppleSilicon-Installer.tar.gz"><img src="https://img.shields.io/badge/macOS-Apple_Silicon-111111?logo=apple&logoColor=white" alt="Download for Apple Silicon Mac" /></a>
  <a href="https://github.com/2092372408-pixel/EduPilot/releases/latest/download/EduPilot-macOS-Intel-Installer.tar.gz"><img src="https://img.shields.io/badge/macOS-Intel-555555?logo=apple&logoColor=white" alt="Download for Intel Mac" /></a>
</p>

<p align="center"><a href="#download">Get started</a> · <a href="#demo">See it in action</a> · <a href="#features">Highlights</a> · <a href="#faq">FAQ</a></p>

<a id="workspace"></a>

<img src="docs/screenshots/study-ready-en.jpg" alt="The actual workspace: an imported chapter-based course with a preview question card in the conversation" width="100%" />

<a id="download"></a>

## Three steps to your first lesson

1. **Download and extract** the package for your computer above. Choose Apple Silicon for an M-series Mac.
2. **Double-click the installer**: EduPilot/install.bat on Windows or EduPilot/install.command on macOS. It creates a desktop icon and opens the learning page.
3. **Try the demo, then bring your materials**: explore the built-in Python course without a key. Connect a model in Settings when you are ready to turn your own materials into a course.

Next time, double-click **EduPilot** on your desktop to study. Closing the last EduPilot page automatically stops the background service; refreshing or moving to practice and reports keeps your session going. Your study records stay on your computer, ready for your next visit.

A tour points to real controls on your first visit, introducing courses, uploads, questions, mistakes and reports. Skip whenever you like, or select **Guide** at the top to replay it. If macOS asks for first-launch confirmation, right-click in Finder and choose **Open**.

<a id="demo"></a>

## From your materials to a complete study session

Import materials → Create a course → Preview check → Learn and practise → View your report. The animation below shows key steps from real interactions.

<details>
<summary>Watch the learning flow in the actual interface</summary>

<img src="docs/demos/learning-journey-en.gif" alt="Learning demonstration: importing materials, a chapter-based course, practice, answer feedback and a learning report" width="100%" />

</details>

<a id="features"></a>

## Three ways to keep learning moving

### Your materials become your course

Import Chinese or English PDF, Word, PowerPoint, Markdown, TXT or JSON files. EduPilot organises chapters and creates topic lessons, examples, common pitfalls and multiple-choice practice. Once ready, your materials follow the same study flow as the built-in demo.

Lessons and questions stay grounded in your materials. Look up relevant passages and ask follow-up questions. Add material over time, reusing existing content as your course grows.

### Preview → Learn → Review, with feedback throughout

Use a preview check to discover unfamiliar topics, build understanding through explanations, practise, then return to consolidate it. Answer question cards directly in the conversation and continue with feedback.

Each topic records its own stage and checks. Revisit mistakes in your notebook; use reports to see progress, pending checks and review plans, then choose your next step.

### Keep your goals and pick up where you left off

Tell your companion your starting point, goals and preferences: “I'm new to Python; everyday examples help me.” Useful information can inform later explanations, while courses, conversations and practice records stay on your computer.

Follow the course step by step or explore another learning question. Each question, exercise and review leaves a starting point for the next session.

<details>
<summary>More ways to make the workspace yours</summary>

- **Practise Python**: write, run and submit code for feedback, ask the practice assistant for a hint, and take a comprehensive assessment after the built-in course.
- **Ask with your materials**: attach an image or document. Choose an image-capable model for pictures.
- **Research when needed**: enable web search to find additional learning material.
- **Use your preferences**: switch between English and Chinese, adjust text size and choose your model service.

</details>

<a id="api-keys"></a>

## Connect your preferred model

Open **Settings → LLM model → Configure provider and key**. Choose a provider, enter your API key, select a model and save. Open-ended answers and generating lessons and questions from your materials use this model and are billed by its provider.

Connect DeepSeek, Qwen, OpenAI, GLM, Kimi or another compatible service. For web research, add a [Tavily key](https://app.tavily.com/home) in **Settings → Web search · Tavily**, then turn search on when needed.

<details>
<summary>Official API key pages</summary>

| Provider | Official page |
| --- | --- |
| DeepSeek | [Create an API key](https://platform.deepseek.com/api_keys) |
| Alibaba Cloud Model Studio · Qwen | [Console](https://bailian.console.aliyun.com/) |
| OpenAI | [Create an API key](https://platform.openai.com/api-keys) |
| Zhipu · GLM | [Create an API key](https://open.bigmodel.cn/usercenter/apikeys) |
| Moonshot · Kimi | [Create an API key](https://platform.kimi.com/console/api-keys) |
| SiliconFlow | [Create an API key](https://cloud.siliconflow.cn/account/ak) |
| Volcengine Ark · Doubao | [Console](https://console.volcengine.com/ark) |
| OpenRouter | [Create an API key](https://openrouter.ai/keys) |

</details>

<a id="faq"></a>

## A few things you might want to know

**Can I try it without an API key?**

Yes. The built-in Python demo needs no key. Real open-ended answers and turning your own materials into courses require a model connection. Web search uses a separate Tavily key.

**Does it support Chinese and English materials?**

Yes, in both content and interface. Use PDFs with extractable text; scanned pages need to be converted to text first.

**Where are my materials and study records stored?**

Materials are parsed on your computer, where courses, conversations and study records are stored. When you use an online model or web search, relevant questions, textbook excerpts or attachments are sent to your selected provider.

**Do I need to install anything else?**

The installer includes the application runtime, so the demo and normal document parsing work immediately. Coding practice needs Python. Optional local semantic search needs Python and an embedding model; keyword search is available without that setup.

**Does closing the page quit the app? What about refreshing?**

When launched from the desktop icon, the service stops about 15 seconds after the last EduPilot page closes. Keep any workspace, practice or report page open to continue; refreshing reconnects. Accepted tasks get a short period to save their results. Double-click the desktop icon to return. To stop immediately, use stop.bat or stop.command in the installation directory.

**Will upgrading keep my learning history?**

Use the newer installer to update the same user's installation directory and preserve settings, courses and learning records. Close EduPilot pages and let the old service exit before installing the update.

## Why we built EduPilot

We want learning to be more scientific, more continuous and more firmly in the learner's hands. Clear goals, exploration, feedback and review help people ask, try, reflect and choose their next step.

Learning is a lifelong path. EduPilot aims to make yesterday's understanding today's starting point, so each question, exercise and breakthrough can support tomorrow's exploration.

> **Learn what you want, then do what you want. Every step deserves to be recorded.**

<a id="feedback"></a>

Have a suggestion, a course you would like to study or a problem to report? Tell us through [GitHub Issues](https://github.com/2092372408-pixel/EduPilot/issues) or [email](mailto:qiuyanzihan2004@gmail.com).

© 2026 **Qiu Yanzihan** · For personal and noncommercial use, see the [license](LICENSE). Contact the author for commercial collaboration. Third-party terms are listed in [Third-Party Notices](THIRD_PARTY_NOTICES.md).
