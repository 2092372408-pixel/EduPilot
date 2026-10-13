# Third-Party Notices

Original EduPilot application code, documentation, and assets are provided under the noncommercial source-available terms in `LICENSE`. Those terms do not relicense third-party components.

Desktop installer packages bundle Node.js 22. Its license and included third-party notices are shipped in `runtime/Node-LICENSE.txt`. Dependency license files remain in the bundled `node_modules` directory.

The runtime dependencies used by the Node image are distributed under permissive licenses recorded in `package-lock.json`, including:

- LangChain Core, LangGraph and LangChain OpenAI: MIT
- Model Context Protocol SDK: MIT
- better-sqlite3: MIT
- tavily-mcp: MIT
- zod: MIT
- jsonrepair: ISC
- `@firecrawl/anydoc@0.2.4` and its platform-specific native binaries: MIT

The bilingual PDF test fixture embeds a subset of Noto Sans SC, licensed under SIL Open Font License 1.1.

The offline getting-started tour bundles Driver.js 1.9.0 (MIT) in `public/vendor/driver-1.9.0`. Its original license is included alongside the unmodified JavaScript and CSS. Source: https://github.com/nilbuild/driver.js; npm tarball SHA-1: `f8bffc39d2fda5a9cda4aa0d4c0887c29228a98f`.

The Docker image adds these Python packages:

- `fastembed==0.8.0`: Apache-2.0
- `markitdown==0.1.7`: MIT

The `fastembed` model is downloaded at runtime when local vector search is first used. Model weights have their own license and terms; verify the selected model license before redistributing a pre-populated model cache or a derivative service.

The `node:22-bookworm-slim` base image and Debian packages remain subject to their respective Debian, Node.js, and package licenses. API providers, MCP services, and their terms are not bundled with this repository.
