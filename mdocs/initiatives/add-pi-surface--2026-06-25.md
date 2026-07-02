---
id: "add-pi-surface"
title: "Add pi surface"
status: "done"
created: "2026-06-25"
updated: "2026-06-25"
owner: ""
tags: ["surface","pi","extension","packaging","harness"]
related_wiki: ["reference/pi-surface"]
priority: "high"
next_action: "Advance to VERIFY/REPORT/COMPLETE; commit docs; final release:check"
---

## Objective
Add a first-class surface for [pi](https://pi.dev) so that pi users can install `harness-mdocs` as a pi package, get mdocs custom tools, workflow enforcement via the `tool_call` event, audit logging via `tool_result`, session orientation, and bundled skills. The surface should mirror the OpenCode/Claude Code capabilities where pi's extension API allows it, and fall back to advisory/skills where it does not.

## Plan
- [ ] Review pi extension API (`ExtensionAPI`, `tool_call`, `tool_result`, `session_start`, `before_agent_start`, `registerTool`, `registerCommand`).
- [ ] Confirm pi built-in tool names are already lowercase (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) and argument keys align with core `WorkflowEngine.isMdocsOperation` checks:
- [ ] - `read`: `{ path, offset?, limit? }`
- [ ] - `write`: `{ path, content }`
- [ ] - `edit`: `{ path, oldText, newText? }`
- [ ] - `bash`: `{ command, timeout? }`
- [ ] - Core already inspects `args.path`, `args.pattern`, and `args.command`, so no translation layer is required for built-ins. Create `translate.ts` only if a future pi tool diverges; otherwise leave it as a typed identity/no-op with comments.
- [ ] Decide result shape: pi tools expect `{ content: Array<{type:'text', text:string}>, details?: any, isError?: boolean }`; wrap core command results accordingly.
- [ ] Decide orientation injection point: append a compact markdown banner to the system prompt in `before_agent_start` (model-visible), plus a `session_start` `ctx.ui.notify` (user-visible).
- [ ] Decide subagent dispatch story: pi has no native subagent, so `mdocs_dispatch` returns assembled context as a tool result for the model to use with `/skill:mdocs-orchestrator` or manual copy-paste.
- [ ] Draft capability table for `src/surfaces/pi/index.ts` comparable to `claudeCodeSurface`/`codexSurface`:
- [ ] - `commandAccess: 'extension-tools'`
- [ ] - `commandTools: true`
- [ ] - `aggregateCommandTool: true`
- [ ] - `skillPackaging: true`
- [ ] - `agentPackaging: false`
- [ ] - `configMutation: false`
- [ ] - `permissionHooks: false` (replaced by `tool_call` blocking)
- [ ] - `toolExecutionHooks: true`
- [ ] - `eventHooks: true` (via pi events)
- [ ] - `subagentDispatch: 'prompted'`
- [ ] Create `src/surfaces/pi/index.ts` exporting the capability table, adapter factory, and public helpers.
- [ ] Create `src/surfaces/pi/adapter.ts` — `createPiAdapter(projectDir, opts?)` wrapping `createMdocsCore` with `bootstrap: { installInitiativeTitle: 'Install and Configure pi-mdocs' }`.
- [ ] Create `src/surfaces/pi/extension.ts` — default extension factory that:
- [ ] - Resolves the project root with `resolveProjectRoot(ctx.cwd)` before building one `MdocsCore` per extension load. Pi extensions are reloaded on session switch/reload, so this naturally refreshes state.
- [ ] - Calls `core.lifecycle.ensureInitialized()`.
- [ ] - Wraps every event handler in `try/catch` and returns/continues safely on error (fail open).
- [ ] - Registers `tool_call` gate: `core.managers.workflow.canExecuteTool(event.toolName, event.input)`; returns `{ block: true, reason }` when blocked. `./mdocs/` paths remain allowed because core already whitelists them.
- [ ] - Registers `tool_result` audit handler: append audit event. In `full` initiative mode, also update the active initiative progress log under `withLock` when step !== `IDLE`; skip the progress-log mutation in `metadata-only` mode.
- [ ] - Registers `before_agent_start` orientation banner using `sessionContext(core)` and a pi-specific formatter (add `src/surfaces/pi/orientation.ts`).
- [ ] - Registers custom tools via `pi.registerTool()` with `promptSnippet` and `promptGuidelines` on every tool.
- [ ] Create `src/surfaces/pi/tools.ts` — `createPiTools(core)` returning tool definitions for:
- [ ] - `mdocs` (aggregate command)
- [ ] - `mdocs_init`, `mdocs_status`, `mdocs_validate`, `mdocs_search`, `mdocs_lookup`, `mdocs_dispatch`, `mdocs_ingest`, `mdocs_audit`, `mdocs_index_check`, `mdocs_resume`, `mdocs_advance`, `mdocs_reset`
- [ ] - Use TypeBox schemas (`Type.Object`, `Type.String`, `Type.Optional`, `Type.Record`, etc.).
- [ ] Create `src/surfaces/pi/orientation.ts` — `formatOrientationBanner(ctx)` that consumes `sessionContext(core)` and returns compact markdown suitable for appending to the system prompt in `before_agent_start`.
- [ ] Create `src/surfaces/pi/result.ts` — `toPiToolResult(value)` returning pi-shaped content; detect `{ error: string }` and surface `isError: true`.
- [ ] Create `src/surfaces/pi/translate.ts` if needed: a minimal passthrough that normalizes tool names/args. If pi conventions already match core, this file can be a thin identity helper plus comments.
- [ ] Create `src/surfaces/pi/skills.ts` — asset resolution for bundled skills (mirrors `src/surfaces/claude-code/skills.ts`).
- [ ] Create bundled skills under `src/surfaces/pi/assets/skills/{mdocs-workflow,mdocs-initiative,mdocs-orchestrator}/SKILL.md` adapted for pi (extension tools, `/skill:name` invocation, advisory fallback notes).
- [ ] Create `src/surfaces/pi/assets/templates/pi-agents-md-snippet.md` for consumers to paste into `AGENTS.md`/`CLAUDE.md`.
- [ ] Add `./pi` export to `package.json` `exports` pointing at `dist/surfaces/pi/index.js` / `.d.ts`.
- [ ] Add pi package manifest to `package.json`. Point the extension at the compiled JS because `prepare`/`prepack` run `npm run build`:
- [ ] Add peer dependencies so pi resolves its bundled runtime packages and type checking works without bundling them:
- [ ] Add `typebox` and `@earendil-works/pi-coding-agent` to `devDependencies` for local builds and tests.
- [ ] Add `src/surfaces/pi` to `files` so TypeScript source and assets ship.
- [ ] Add `test:pi` npm script and include it in quality gate if appropriate.
- [ ] Create a reusable `ExtensionAPI` mock that records `pi.on()` subscriptions, `pi.registerTool()` calls, and `pi.registerCommand()` calls, and provides a fake `ctx` with `cwd`, `hasUI`, `ui.notify`, `sessionManager`, `signal`, and `getSystemPrompt`.
- [ ] `adapter.test.ts` — `createPiAdapter` returns an object with tools; `extension` default export is a function.
- [ ] `extension.test.ts` — use the mock; assert `tool_call` gate blocks `write` at `IDLE`/`UNDERSTAND`, allows at `PLAN`; assert `tool_result` appends audit; assert `before_agent_start` injects orientation; assert `metadata-only` skips progress-log mutation; assert handlers never throw.
- [ ] `tools.test.ts` — each pi tool executes the expected core command and returns pi-shaped content.
- [ ] `result.test.ts` — successful results and `{error}` results are wrapped correctly, including `isError: true`.
- [ ] `translate.test.ts` if translate layer is non-trivial.
- [ ] Create `docs/pi-surface.md` covering: install (`pi install npm:harness-mdocs`), capabilities, workflow enforcement via extension, available tools, skills, and limitations compared to Claude Code/OpenCode.
- [ ] Update README surface table and add a pi usage section.
- [ ] Update `docs/packaging-strategy.md` with pi entrypoints and dogfood notes.
- [ ] Run `npm run build`, `npm test`, `npm run coverage`, `npm run mdocs:validate`.
- [ ] Smoke-test the pi package locally: `pi -e ./` from repo root, verify skills appear, verify `mdocs_status` tool returns orientation, verify `write` is blocked before `PLAN`.
- [ ] Run `npm run pack:check` and confirm `src/surfaces/pi` and `dist/surfaces/pi` are in the tarball.
- [ ] Run `mdocs command index.sync` to regenerate `mdocs/initiatives/INDEX.md` and wiki indices.

## Progress Log
- [2026-06-25] Created initiative plan.
- [2026-06-25] Reviewed for handoff: added constraints, fail-open notes, pi tool shape details, `promptSnippet`/`promptGuidelines` requirement, orientation helper, mock guidance, package.json peer-dep snippets, and risks section.
- [2026-06-25] Scoped subagent support to future version: documented `/mdocs-subagent` command and `mdocs_subagent` tool as out-of-scope for initial surface.
- Implemented pi surface runtime: extension.ts (tool_call gate, tool_result audit+progress, before_agent_start orientation, session_start notify, fail-open), adapter, tools (13 tools w/ TypeBox schemas + promptSnippet/promptGuidelines), result, translate, orientation, skills, index. Added skill assets (mdocs-workflow/initiative/orchestrator) + pi-agents-md-snippet template. Wired package.json (./pi export, pi manifest, peer deps, files, devDeps, test:pi). Added tests (mock, adapter, extension, tools, result) — 44 pi tests pass, full suite 459 pass, coverage above thresholds.
- [2026-06-25T08:17:31.186Z] mdocs_status executed at step EXECUTE
- Added docs/pi-surface.md; updated README surface table + pi Usage section + Entry Points; updated docs/packaging-strategy.md (pi entrypoint, tarball check, pi dogfood). Smoke-tested with pi -e ./: mdocs_status returns real state, all 3 mdocs skills appear, write blocked at UNDERSTAND with correct reason. Build/test/coverage/mdocs:validate/pack:check all green; dist/surfaces/pi + src/surfaces/pi in tarball.
- [2026-06-25T08:19:21.702Z] Marked done via mdocs command

## Artifacts
