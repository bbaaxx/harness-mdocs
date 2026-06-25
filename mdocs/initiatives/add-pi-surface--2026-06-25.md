---
id: "add-pi-surface"
title: "Add pi surface"
status: "active"
created: "2026-06-25"
updated: "2026-06-25"
owner: ""
tags: ["surface","pi","extension","packaging","harness"]
related_wiki: []
priority: "high"
---

## Objective
Add a first-class surface for [pi](https://pi.dev) so that pi users can install `harness-mdocs` as a pi package, get mdocs custom tools, workflow enforcement via the `tool_call` event, audit logging via `tool_result`, session orientation, and bundled skills. The surface should mirror the OpenCode/Claude Code capabilities where pi's extension API allows it, and fall back to advisory/skills where it does not.

## Plan

### 1. Design the pi ↔ core mapping
- [ ] Review pi extension API (`ExtensionAPI`, `tool_call`, `tool_result`, `session_start`, `before_agent_start`, `registerTool`, `registerCommand`).
- [ ] Confirm pi built-in tool names are already lowercase (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) and argument keys (`path`, `command`) align with core `WorkflowEngine.isMdocsOperation` checks. Decide whether a dedicated `translate.ts` is needed or if a thin passthrough/shim suffices.
- [ ] Decide result shape: pi tools expect `{ content: Array<{type:'text', text:string}>, details?: any, isError?: boolean }`; wrap core command results accordingly.
- [ ] Decide orientation injection point: append a compact markdown banner to the system prompt in `before_agent_start` (model-visible), plus a `session_start` `ctx.ui.notify` (user-visible).
- [ ] Decide subagent dispatch story: pi has no native subagent, so `mdocs_dispatch` returns assembled context as a tool result for the model to use with `/skill:mdocs-orchestrator` or manual copy-paste.
- [ ] Draft capability table for `src/surfaces/pi/index.ts` comparable to `claudeCodeSurface`/`codexSurface`:
  - `commandAccess: 'extension-tools'`
  - `commandTools: true`
  - `aggregateCommandTool: true`
  - `skillPackaging: true`
  - `agentPackaging: false`
  - `configMutation: false`
  - `permissionHooks: false` (replaced by `tool_call` blocking)
  - `toolExecutionHooks: true`
  - `eventHooks: true` (via pi events)
  - `subagentDispatch: 'prompted'`

### 2. Implement the runtime surface (`src/surfaces/pi/`)
- [ ] Create `src/surfaces/pi/index.ts` exporting the capability table, adapter factory, and public helpers.
- [ ] Create `src/surfaces/pi/adapter.ts` — `createPiAdapter(projectDir, opts?)` wrapping `createMdocsCore` with `bootstrap: { installInitiativeTitle: 'Install and Configure pi-mdocs' }`.
- [ ] Create `src/surfaces/pi/extension.ts` — default extension factory that:
  - Builds one `MdocsCore` per extension load (pi extensions are reloaded on session switch/reload, so this naturally refreshes state).
  - Calls `core.lifecycle.ensureInitialized()`.
  - Registers `tool_call` gate: `core.managers.workflow.canExecuteTool(event.toolName, event.input)`; returns `{ block: true, reason }` when blocked. `./mdocs/` paths remain allowed because core already whitelists them.
  - Registers `tool_result` audit handler: append audit event. In `full` initiative mode, also update the active initiative progress log under `withLock` when step !== `IDLE`; skip the progress-log mutation in `metadata-only` mode.
  - Registers `before_agent_start` orientation banner using `sessionContext(core)` and `formatOrientationBanner(ctx)`.
  - Registers custom tools via `pi.registerTool()`.
- [ ] Create `src/surfaces/pi/tools.ts` — `createPiTools(core)` returning tool definitions for:
  - `mdocs` (aggregate command)
  - `mdocs_init`, `mdocs_status`, `mdocs_validate`, `mdocs_search`, `mdocs_lookup`, `mdocs_dispatch`, `mdocs_ingest`, `mdocs_audit`, `mdocs_index_check`, `mdocs_resume`, `mdocs_advance`, `mdocs_reset`
  - Use TypeBox schemas (`Type.Object`, `Type.String`, `Type.Optional`, `Type.Record`, etc.).
- [ ] Create `src/surfaces/pi/result.ts` — `toPiToolResult(value)` returning pi-shaped content; detect `{ error: string }` and surface `isError: true`.
- [ ] Create `src/surfaces/pi/translate.ts` if needed: a minimal passthrough that normalizes tool names/args. If pi conventions already match core, this file can be a thin identity helper plus comments.
- [ ] Create `src/surfaces/pi/skills.ts` — asset resolution for bundled skills (mirrors `src/surfaces/claude-code/skills.ts`).
- [ ] Create bundled skills under `src/surfaces/pi/assets/skills/{mdocs-workflow,mdocs-initiative,mdocs-orchestrator}/SKILL.md` adapted for pi (extension tools, `/skill:name` invocation, advisory fallback notes).
- [ ] Create `src/surfaces/pi/assets/templates/pi-agents-md-snippet.md` for consumers to paste into `AGENTS.md`/`CLAUDE.md`.

### 3. Wire package metadata and exports
- [ ] Add `./pi` export to `package.json` `exports` pointing at `dist/surfaces/pi/index.js` / `.d.ts`.
- [ ] Add pi package manifest to `package.json`:
  ```json
  "pi": {
    "extensions": ["./dist/surfaces/pi/extension.js"],
    "skills": ["./src/surfaces/pi/assets/skills"]
  }
  ```
- [ ] Add `typebox` to `devDependencies` and as an optional `peerDependencies` entry (pi bundles it at runtime; declaring it avoids bundling).
- [ ] Add `@earendil-works/pi-coding-agent` as an optional `peerDependencies` entry for type checking only (no runtime import of values).
- [ ] Add `src/surfaces/pi` to `files` so TypeScript source and assets ship.
- [ ] Add `test:pi` npm script and include it in quality gate if appropriate.

### 4. Add tests (`tests/surfaces/pi/`)
- [ ] `adapter.test.ts` — `createPiAdapter` returns an object with tools; `extension` default export is a function.
- [ ] `extension.test.ts` — mock `ExtensionAPI`; assert `tool_call` gate blocks `write` at `IDLE`/`UNDERSTAND`, allows at `PLAN`; assert `tool_result` appends audit; assert `before_agent_start` injects orientation; assert `metadata-only` skips progress-log mutation.
- [ ] `tools.test.ts` — each pi tool executes the expected core command and returns pi-shaped content.
- [ ] `result.test.ts` — successful results and `{error}` results are wrapped correctly.
- [ ] `translate.test.ts` if translate layer is non-trivial.

### 5. Documentation
- [ ] Create `docs/pi-surface.md` covering: install (`pi install npm:harness-mdocs`), capabilities, workflow enforcement via extension, available tools, skills, and limitations compared to Claude Code/OpenCode.
- [ ] Update README surface table and add a pi usage section.
- [ ] Update `docs/packaging-strategy.md` with pi entrypoints and dogfood notes.

### 6. Dogfood and validation
- [ ] Run `npm run build`, `npm test`, `npm run coverage`, `npm run mdocs:validate`.
- [ ] Smoke-test the pi package locally: `pi -e ./` from repo root, verify skills appear, verify `mdocs_status` tool returns orientation, verify `write` is blocked before `PLAN`.
- [ ] Run `npm run pack:check` and confirm `src/surfaces/pi` and `dist/surfaces/pi` are in the tarball.
- [ ] Run `mdocs command index.sync` to regenerate `mdocs/initiatives/INDEX.md` and wiki indices.

## Acceptance Criteria
- `src/surfaces/pi/` exists with extension, adapter, tools, result, translate, skills, and assets.
- `package.json` exposes `./pi`, declares the `pi` manifest, and lists pi surface files.
- All new tests pass; overall `npm test` green; `npm run mdocs:validate` valid.
- Local `pi -e ./` smoke test shows skills, blocks pre-PLAN writes, and `mdocs_status` works.
- Docs and README describe the pi surface accurately.

## Progress Log
- [2026-06-25] Created initiative plan.

## Artifacts
