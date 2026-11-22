# Contributing to EduPilot

Thank you for your interest in EduPilot. Useful contributions include reproducible bug reports, thoughtful feature proposals, usability feedback, documentation improvements, tests, and code.

## Before making a change

1. Read the [README](README.md) to understand the product and its current capabilities.
2. Check the [roadmap](ROADMAP.md) and existing [issues](https://github.com/2092372408-pixel/EduPilot/issues) to avoid duplicating work.
3. For a substantial change, open an issue first so the scope and acceptance criteria can be discussed.

## Current contribution and license status

The repository is currently distributed under the terms in [LICENSE](LICENSE). The maintainer is evaluating a possible transition to **MIT OR Apache-2.0**, but that change is not effective yet.

Until updated contribution terms are published, please use Issues for bug reports, proposals, and feedback. Before submitting code, documentation, or assets for inclusion, open an issue and confirm the applicable contribution terms with the maintainer. Do not assume a proposed future license applies to contributions today.

## Development setup

### Requirements

- Node.js 22 or later
- Python 3 for document conversion and local semantic search
- Windows or macOS for platform-specific desktop testing

### Run locally

```bash
git clone https://github.com/2092372408-pixel/EduPilot.git
cd EduPilot
npm ci
npm run check:publication
npm start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). Configure a model provider in Settings to use AI conversations and generate courses. The built-in Python diagnostic exercises can be tried without configuring an API key.

For desktop development and packaging, see the [desktop guide](docs/桌面启动与退出说明.md). For product usage, see the [learning guide](docs/学生端说明书.md).

## Reporting a bug

Use the [Bug report form](https://github.com/2092372408-pixel/EduPilot/issues/new?template=bug_report.yml). Include:

- EduPilot version and operating system
- Steps to reproduce the problem
- Expected and actual behavior
- Relevant logs, after removing API keys, tokens, personal information, and private study material

## Proposing a feature

Use the [Feature request form](https://github.com/2092372408-pixel/EduPilot/issues/new?template=feature_request.yml). Describe the user problem first, then the proposed solution and alternatives.

## Pull request expectations

Once contribution terms are confirmed, please:

- Keep each change focused and explain why it is needed.
- Follow the existing project structure and naming conventions.
- Update documentation when user-facing behavior changes.
- Include screenshots or a short recording for UI changes.
- Add or update tests where practical.
- Run `npm run check:publication` before opening the PR.
- Never commit API keys, credentials, private datasets, or personal learning records.

The CI workflows also run publication-boundary checks and platform-specific desktop smoke tests. A green CI run is helpful, but it does not replace manual testing of the affected workflow.

## Questions

For installation and usage help, see [SUPPORT.md](SUPPORT.md). For project direction, see [ROADMAP.md](ROADMAP.md).
