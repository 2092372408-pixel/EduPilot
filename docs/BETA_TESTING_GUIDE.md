# EduPilot Beta Testing Guide

Thank you for helping test EduPilot. The goal is to understand whether the product helps people move from learning materials to structured study, practice, review, and visible progress.

## Before you start

1. Download the latest release for your operating system from [GitHub Releases](https://github.com/2092372408-pixel/EduPilot/releases/latest).
2. Follow the [desktop installation guide](桌面启动与退出说明.md).
3. You can try the built-in Python diagnostic exercises without an API key.
4. To use AI conversations and course generation, configure your own supported model provider in Settings. Check the provider's pricing and privacy terms first.

## Suggested test journey

### 1. First launch and setup

- Install and launch the application.
- Check whether the onboarding and navigation are understandable.
- Open Settings and inspect the model-provider configuration.
- Record any confusing step, error message, or platform-specific issue.

### 2. Import and organise learning materials

- Import a small, non-sensitive PDF, Word, PowerPoint, Markdown, or TXT document.
- Check whether the material is recognised and organised into a useful course structure.
- Inspect chapter titles, content coverage, and source alignment.
- Note missing pages, broken formatting, incorrect extraction, or unexpected delays.

### 3. Learn and ask questions

- Open a chapter and read its explanation.
- Ask a question grounded in the imported material.
- Check whether the answer is relevant and whether it reflects the source.
- Try a follow-up question and observe whether the context is retained appropriately.

### 4. Practise and review

- Try the built-in Python diagnostic exercises.
- Inspect the feedback, hints, expected output, and actual output.
- Correct an answer and try a fresh variant.
- If available in your workflow, inspect mistake records, review scheduling, and learning reports.

### 5. Inspect progress and knowledge connections

- Return to the learning home and check course progress.
- Inspect skill areas and learning records.
- Explore the knowledge graph and verify whether relationships are understandable.
- Try the learning card or sharing workflow, taking care not to expose private study information.

## Feedback checklist

For each issue or suggestion, include:

- EduPilot version and operating system.
- The workflow or page involved.
- Steps to reproduce, where applicable.
- Expected result and actual result.
- Screenshot or short screen recording, with private information removed.
- How much the issue affects your ability to continue learning.

For broader product feedback, describe what you were trying to learn and whether EduPilot helped you make progress.

## Report a bug or share an idea

- [Submit beta feedback](https://github.com/2092372408-pixel/EduPilot/issues/new?template=beta_feedback.yml)
- [Report a reproducible bug](https://github.com/2092372408-pixel/EduPilot/issues/new?template=bug_report.yml)
- [Suggest a feature](https://github.com/2092372408-pixel/EduPilot/issues/new?template=feature_request.yml)

Search existing issues before opening a new one. Do not include API keys, tokens, personal information, private learning materials, or private account details.

## Important data and privacy notes

EduPilot stores courses, conversations, and learning records in the local application data directory. When AI features are used, relevant prompts, material excerpts, or attachments are sent to the model provider selected in Settings. Local storage does not mean that content sent to an external model provider remains local.

Use non-sensitive sample materials for testing whenever possible. Remove secrets and personal information from screenshots and logs before sharing them publicly.
