# Repository publication rules

- GitHub synchronization covers product source, launchers, licenses, approved user documentation and marketing assets only.
- Personal career/interview/resume materials, internal test suites, fixtures, evaluation datasets, reports, logs, API keys and user learning data stay local. A request to push or release the project does not authorize publishing them.
- Preserve local private files when removing them from Git. Never stage the whole workspace without inspecting the staged paths and diff.
- `.github/publication-files.json` is the publication allowlist. New documentation/data paths require an explicit publication decision; do not expand it just to make a failing check pass.
- Before pushing, run `npm run check:publication -- --staged` and inspect `git diff --cached`. CI and desktop packaging must run the same guard. Do not upload private verification reports as Actions artifacts.
- This checkout uses `.githooks` to block unapproved commits and pushes. In new development clones, enable them with `git config core.hooksPath .githooks`. Do not bypass these hooks to publish a rejected file.
- Internal functional verification remains local: `node tools/verify-project.js`; retrieval evaluation: `node tools/verify-project.js --eval`. These files and their results must not be committed or bundled.
- README and release notes address users: describe capabilities, installation and relevant limitations. Keep interview answers, internal execution records and test examples out of them.
