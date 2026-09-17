---
id: "kimi-code-surface"
title: "Kimi Code Surface Architecture"
category: "reference"
created: "2026-09-16"
updated: "2026-09-16"
related_initiatives: ["kimi-code-surface-for-harness-mdocs","release-harness-mdocs-2-1-0"]
tags: ["surface","kimi-code","hooks","plugin","packaging"]
lifecycle: "stable"
knowledge_type: "reference"
confidence: "high"
---

# Kimi Code Surface

The kimi-code surface (`src/surfaces/kimi-code/`) exposes harness-mdocs to [Kimi Code CLI](https://www.kimi.com/code/docs/en/) as a Kimi plugin. It is a Tier 3 surface (full host-level enforcement) alongside OpenCode, Claude Code, and pi.

## Capability profile

`kimiCodeSurface` (exported from `harness-mdocs/kimi-code`) declares: `commandAccess: 'mcp'`, enforced `PreToolUse`/`PostToolUse` hooks, `SessionStart` orientation, skill + agent packaging, and `subagentDispatch: 'native'` (the `Agent` tool). Unlike Claude Code, Kimi plugin manifests can ship agents, so the orchestrator agent is packaged with the plugin.

## Layout

- `translate.ts` — pure payload translation. Kimi Code hook stdin is snake_case JSON with PascalCase tool names (`Write`, `Edit`, `Bash`, `Agent`, `AgentSwarm`); core expects lowercase names and camelCase args. Same silent-failure mode as Claude Code without it, so the map is unit-tested against a real `WorkflowEngine`.
- `hooks.ts` — adapter-level `preToolUse` (gate) / `postToolUse` (audit only; progress log stays intentional per friction-log F6).
- `cli/pre-tool-use.ts`, `cli/post-tool-use.ts`, `cli/session-start.ts` — hook entrypoints implementing Kimi's contract: exit 2 + stderr blocks a tool; PostToolUse is observation-only; SessionStart exit-0 stdout (plain markdown — Kimi has no `additionalContext` JSON envelope) lands in session context. All fail open.
- `mcp-server.ts` — re-exports the shared Claude Code MCP registration (`buildMcpServer`), plus `buildKimiMcpServer` alias for parity tests.
- `plugin/` — Kimi plugin root: `kimi.plugin.json` manifest (name `mdocs`, version-stamped from `package.json` by `scripts/stamp-versions.js`) declaring `skills/`, `agents/`, `sessionStart.skill`, `mcpServers`, and three hooks with `./dist/hooks/*.js` commands. `plugin/dist/` is esbuild-bundled by `scripts/build-kimi-plugin.sh` (zero external requires; Kimi runs plugin hook commands with cwd = plugin root).
- `assets/` — install templates for the manual path (`kimi-mcp.json`, `kimi-agents-md-snippet.md`) plus skill/agent copies.

## Key facts

- MCP tools surface as `mcp__mdocs__<tool>`; the parity contract in `tests/surfaces/parity.test.ts` covers kimi-code via `buildKimiMcpServer`.
- Skills are Kimi-format `SKILL.md` (explicit `name`/`description` frontmatter, optional `whenToUse`); all kimi assets are generator-managed fragments (`kimi-*`), including this repo's own `.kimi-code/skills/` + `.kimi-code/agents/` dogfood outputs.
- Kimi Code quirks worth remembering: plugins install per-user (no project scope yet); plugin/MCP changes need `/reload` or a new session; hooks fail open by design, so the gate must exit 2 only on an explicit, successful denial.
