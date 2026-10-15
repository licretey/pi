# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/install-lock/` needs regen, run `node scripts/generate-coding-agent-install-lock.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

For release preparation, publishing, verification, or recovery, load and follow [.pi/skills/release.md](.pi/skills/release.md).

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.


<claude-mem-context>
# Memory Context

# [pi] recent context, 2026-10-15 1:36am GMT+8

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (21,290t read) | 3,657,228t work | 99% savings

### Oct 10, 2026
6179 12:32p 🔵 Project root structure of ai-flow/pi revealed: TypeScript monorepo with Nix and Vitest
6185 " ✅ Documentation workflow advanced: structure reconnaissance complete, parallel package exploration started
6186 " 🔵 coding-agent CLI manifest revealed: pi bin → dist/bundle/cli.js, separate rpc-entry and plugin exports
6187 " 🔵 agent package core runtime files identified; three parallel Explore agents dispatched across startup, loop, and ai/durable layers
6188 " 🔵 coding-agent CLI boot chain mapped: cli.ts → setupCli → main mode dispatch (rpc/json/print/interactive)
6189 " 🔵 coding-agent bundle build: esbuild with strict external allowlist, lazy OAuth entries, data-URL codemode worker
6190 " 🔵 Agent core loop mechanics: steering/follow-up queues, tool-declaration system messages, truncated-call failure, nested runToolCall
6191 " 🔵 pi-ai architecture: side-effect-free core, 43 builtin providers, lazy API modules, deferred responses, generated model catalog
6192 " 🔵 RPC stack: protocol v8 over CBOR length-prefixed frames, server handshake + session router, unix-socket client
6193 " 🔵 pi-durable semantics: commit-before-show harness, durable tasks, nested tools with replay policy, storage-failure fatality
6194 " 🔵 Support packages characterized: tui, chord, env, mcp, codemode, telemetry, evals
6195 " 🔵 coding-agent config.ts and AgentSessionRuntime: install detection, path resolution, session replacement flows
S1938 pi 项目文档工作：(1) 架构文档与自包含 HTML 已产出并归档 docs/（含 Mermaid 渲染验证）；(2) 新请求——为 TS 基础较差的开发者编写源码学习文档，包含必要的 TypeScript 基础知识盘点与阅读路径。 (Oct 10, 12:35 PM)
S1936 整理 pi 项目（14 包 monorepo）的启动与执行流程：用流程图/时序图说明项目原理、各代码实现的功能及各模块代码职责——已进入核心链路精读阶段 (Oct 10, 12:35 PM)
6203 12:36p ⚖️ Beginner-oriented TypeScript source-reading guide requested for pi monorepo
S1937 整理 pi 项目（/home/de/d/code/ai-flow/pi）的启动与执行流程：用流程图与时序图详细说明项目原理、各代码实现的功能、以及各模块下代码的职责；最终产出中文文档并要求 Mermaid 图表实际可渲染。任务已完成（4 个子任务全部 completed）。 (Oct 10, 12:39 PM)
S1939 pi 项目工作流：(1) 启动与执行流程架构文档已完成并归档至 docs/（自包含 HTML，7/7 Mermaid 渲染验证通过）；(2) 当前请求——为 TS 基础较差的开发者整理一份详细的源码学习文档，包含必要前置知识点、分阶段阅读路线与练习清单。 (Oct 10, 12:42 PM)
S1941 pi 项目第三项任务：为 TS 基础薄弱的开发者撰写源码学习指南（TS 前置知识 + 分阶段学习路线 + 练习清单）。最新用户反馈：文档"有些内容看不懂，虽然进行了说明，但没有对具体的写法案例表达的意思进行说明"——要求为具体代码写法案例补充含义解释。指南首版已写入 docs/PI_LEARNING_GUIDE_ZH.md，任务 6 已标记完成。 (Oct 10, 12:42 PM)
6204 12:58p 🔵 User feedback: learning guide code examples need per-example meaning explanations
S1940 pi 项目三项请求已全部完成：(1) 架构文档（启动/执行流程 + Mermaid 图）并归档 docs/；(2) 为 TS 基础薄弱的开发者撰写源码学习指南，包含前置知识、学习路线、练习清单——本轮已产出 docs/PI_LEARNING_GUIDE_ZH.md 并收尾。 (Oct 10, 12:58 PM)
S1942 pi 项目第三项任务：TS 源码学习指南（docs/PI_LEARNING_GUIDE_ZH.md）已写入并标记完成。用户随后反馈："有些内容看不懂，虽然进行了说明，但没有对具体的写法案例表达的意思进行说明，需要你补充一下"——当前工作转入为每个具体写法案例补充含义解释；本批次同时捕获到补充素材的新一轮采集（读取各案例完整上下文）。 (Oct 10, 2:42 PM)
### Oct 13, 2026
6287 12:10a 🔵 **Session continuation**: Primary session resumed with no new tool activity recorded
6288 " 🔵 **已记录的危险操作已确认**：文档文件易受外部覆盖影响，并带有哈希验证协议
6291 " 🔵 **危险区域审查**：在进行编辑前，重新确认了清理程序
6289 12:11a ✅ **已建立文档基准**：根据 clobbering-hazard 协议，在编辑指南前对 PI_LEARNING_GUIDE_ZH.md 进行了基线评估
6290 " 🔵 **在指南中发现了未回答的问题**：关于类型谓词返回类型如何缩小参数类型范围的内联“？？？”
6292 12:12a 🔵 **正在读取源码以准备文档编辑**：`agent.ts` 和 `types.ts` 已被检查，用于指南的更新工作
6293 " 🔵 **Working-tree audit**：145 个文件带有大范围的注释翻译（EN→ZH）
6295 " 🔵 **翻译差异重查**：145文件注释翻译`git diff`统计被再次确认
6297 " 🔵 **重复的翻译差异检查**：145次文件提交统计第三次出现未变
6298 " 🔵 **未触及的文件已映射**：翻译中仍包含大量英文注释的30个源文件
6299 " 🔵 **发现误报**：`overflow.ts` 中的“英文注释”实际上是必须保持原样的逐字提供商错误信息引用
6294 12:13a 🔵 **会话历史检索**：记忆搜索显示了跨会话学习指南编辑历史
6296 " 🔵 **剩余翻译目标已识别**：基于注释扫描，12个文件仍包含类似英文的注释
6300 12:15a 🔵 **Next translation target**：枚举了 `agent-session.ts` 的约 90 行英文注释
6301 " 🔵 **Translation batch scoped**: agent-session.ts lines 1-650 loaded for comment translation
6302 12:16a 🔵 **Translation inventory complete**: agent-session.ts English comments mapped through line 2284
6303 " 🔵 **Translation inventory complete**: agent-session.ts English comments fully mapped line 2284-4399
6304 12:17a ⚖️ **翻译工作委派**：general-purpose 子智能体已被派发翻译 5 个 coding-agent 核心文件的任务
6305 " ✅ **并行翻译启动**：两个子智能体已发起，覆盖 coding-agent 核心及模式层文件
6306 " 🔵 用户确认所有英文注释均需翻译
6307 12:20a ⚖️ **注释翻译范围**：确认所有英文注释均需翻译
6308 12:21a ⚖️ **title**: User reconfirms full-scope English comment translation task
6318 12:26a ✅ 用户强调：代码库中的所有英文注释都必须翻译
6319 " ✅ pi monorepo 持续进行批量英文注释翻译为中文的工作
6320 " 🔴 generation.ts 注释翻译完成验证
6321 12:31a ⚖️ **User clarified scope: translate all English comments**
6322 12:33a ✅ User confirms translation task must cover all English comments
6323 12:34a ✅ session.ts comment translation completed after indentation mismatches fixed
6324 " ✅ task-graph.ts comments translated to Chinese with one indentation retry
6325 " 🔵 Comment-translation verification pattern established; stdin-buffer swept and bash.ts queued
6326 12:35a ✅ stdin-buffer.ts translation finished; comment-stripped code verified identical to HEAD
6327 " ✅ bash.ts English comments translated; edit-diff.ts verified already fully Chinese
6328 " ✅ registry.ts swept: only the createRegistry docblock was still English
6329 " ✅ Comment sweep expanded into packages/coding-agent; mcp/index.ts underway
6330 " 🔵 line-scan.ts verified already fully Chinese — no edits needed
6331 12:37a ⚖️ 任务范围确认：翻译所有英文注释

Access 3657k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>