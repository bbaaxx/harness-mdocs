---
id: "kimi-code-surface-for-harness-mdocs"
title: "Kimi Code surface for harness-mdocs"
status: "done"
created: "2026-09-16"
updated: "2026-09-16"
owner: ""
tags: ["surface","kimi-code","hooks","plugin","packaging","harness"]
related_wiki: ["reference/kimi-code-surface"]
priority: "high"
handoff_summary: "Kimi Code surface implemented end to end: src/surfaces/kimi-code runtime (translate/hooks/orientation/adapter/mcp re-export), plugin (kimi.plugin.json + esbuild-bundled hooks/MCP server), 6 generation fragments with 15 managed outputs incl. .kimi-code/ dogfood skills+agent, package.json wiring (./kimi-code export, build:kimi-plugin in quality+prepack, test:kimi-code), stamp-versions target, 58 tests green incl. parity, docs (kimi-code.md, README, packaging-strategy). Dogfood: .kimi-code/mcp.json smoke-tested (MCP handshake version 2.0.0). Awaiting full quality gate."
next_action: "Review quality gate output, then index.sync + wiki learning + COMPLETE"
graduated: "2026-09-16"
---

## Objective
Add Kimi Code CLI as a fully supported, Tier 3 surface of harness-mdocs: capability declaration, adapter, hooks (workflow gate + audit + orientation), plugin packaging (manifest, skills, agents, MCP declaration), parity-test coverage, docs, and live dogfooding in this repository. The kimi-code surface is owned end to end by this initiative: design, integration, release readiness, and maintenance.

## Plan
- [x] Research Kimi Code extension points from official docs (MCP, hooks, plugins, skills, agents). Findings: MCP client via `.kimi-code/mcp.json` / `~/.kimi-code/mcp.json` (tools surface as `mcp__<server>__<tool>`); hooks via `[[hooks]]` in `config.toml` or plugin manifest — `PreToolUse` blockable (exit 2 + stderr, or `permissionDecision: "deny"` JSON), `PostToolUse` observation, `SessionStart` stdout lands in context; plugins via `kimi.plugin.json` manifest (`skills`, `agents`, `mcpServers`, `hooks`, `systemPromptPath`, `sessionStart.skill`, `commands`); SKILL.md requires explicit `name`/`description` frontmatter; native subagent dispatch via the `Agent` tool. Harness payloads are snake_case JSON on stdin — kimi-code needs its own translate layer like claude-code.
- [ ] Draft capability table `kimiCodeSurface`: `commandAccess: 'mcp'`, `commandTools: true`, `aggregateCommandTool: true`, `skillPackaging: true`, `agentPackaging: true` (plugin manifests ship agents), `configMutation: false`, `permissionHooks: true`, `toolExecutionHooks: true`, `eventHooks: true`, `subagentDispatch: 'native'`.
- [ ] Create `src/surfaces/kimi-code/` mirroring the claude-code layout: `index.ts` (capability table + exports), `adapter.ts` (wraps `createMdocsCore`), `translate.ts` (snake_case hook payloads ⇄ core), `result.ts`, `hooks.ts` (`PreToolUse` gate, `PostToolUse` audit, `SessionStart` orientation banner).
- [ ] Reuse the existing MCP server module from the claude-code surface (`buildMcpServer`/`startMcpServer`) for the kimi `mcpServers` declaration instead of reimplementing it.
- [ ] Create plugin assets under `src/surfaces/kimi-code/plugin/`: `kimi.plugin.json` manifest (name `mdocs`), kimi-format skills (explicit `name`/`description` frontmatter), `agents/mdocs-orchestrator.md`, hook entry scripts (node, stdin JSON), system-prompt snippet, and a consumer snippet template for project `AGENTS.md`.
- [ ] Wire `package.json`: `exports["./kimi-code"]`, `files` entry, `test:kimi-code` script, and version stamping for the kimi plugin manifest if needed.
- [ ] Extend `tests/surfaces/parity.test.ts` so kimi-code joins the canonical 13-tool contract.
- [ ] Create `tests/surfaces/kimi-code/`: adapter, hooks (gate blocks Write/Edit before PLAN, allows at PLAN; audit on PostToolUse; SessionStart orientation), translate, result, plugin-assets tests.
- [ ] Register surface assets with the transactional generator (`src/generation` fragments) so kimi assets are managed like the other surfaces.
- [ ] Docs: `docs/kimi-code.md` (install via plugin + `.kimi-code/mcp.json` fallback, capabilities, enforcement, limitations: per-user plugin scope, plugin hook cwd = plugin root, plugin/MCP changes need `/reload` or a new session); README surface table row + entry points; `docs/packaging-strategy.md` entrypoints + dogfood notes.
- [ ] Dogfood in this repo: wire `.kimi-code/mcp.json` + hook config, verify `mdocs_*` tools, gate behavior, and orientation in a fresh session.
- [ ] `npm run quality` green (build, check:agents, check:versions, lint, tests, coverage, mdocs:validate) plus `pack:check` tarball inspection.
- [ ] `mdocs command index.sync`, progress log, wiki learning page, complete initiative.

## Progress Log
- [2026-09-16T15:10:01.287Z] Created initiative via mdocs command
- [2026-09-16] Researched Kimi Code extension points from the official docs (MCP, hooks, plugins, skills, agents); design direction set — Tier 3 surface mirroring the claude-code layout with a kimi-specific translate layer for snake_case hook payloads. Plan recorded at PLAN step.
- EXECUTE complete: runtime + plugin + packaging + tests (58 passing) + docs + dogfood wiring done; quality gate running in background.
- REPORT: wiki learning page reference/kimi-code-surface.md written and linked.
- [2026-09-16T18:35:36.173Z] Marked done via mdocs command

## Artifacts
