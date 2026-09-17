---
id: "verify-docs-after-v2-kimi-code-surface"
title: "Verify docs after v2 + kimi-code surface"
status: "done"
created: "2026-09-16"
updated: "2026-09-16"
owner: ""
tags: []
related_wiki: ["docs/surface-release-docs-checklist"]
priority: "medium"
next_action: "Execute fixes in 5 files, then verify with npm run quality + mdocs validate"
graduated: "2026-09-16"
---

## Objective
Audit and update all documentation (user-manual, agent-manual, surface guides, packaging docs, skill/agent prompts, README) so it accurately reflects the v2.0.0 release and the newly added kimi-code surface. Every doc must match the current code and packaging reality.

## Plan


## Progress Log
- [2026-09-16T19:17:18.396Z] Created initiative via mdocs command
- Audit complete (explore agent, thorough). Findings: (1) docs/agent-manual.md missing Kimi Code throughout (header, S1, S5 dispatch, S8 table, S11 orientation); (2) docs/user-manual.md missing S2.5 Kimi Code install; (3) README.md stale: OpenCode pins 0.4.0/0.5.0 (now 2.0.0), architecture tree missing pi+kimi-code+agents, Claude MCP list missing mdocs_ingest/mdocs_advance, OpenCode tools list missing 3 tools, dev commands missing test:pi/test:kimi-code, several surface enumerations omit kimi-code; (4) docs/packaging-strategy.md: stamp-versions omits kimi.plugin.json, Node matrix missing 24, tarball checklist lists nonexistent templates/ + omits docs/.claude-plugin; (5) agents/mdocs-orchestrator.md custom-tools list missing 4 tools. docs/kimi-code.md, prompts/, skills/, CLAUDE.md verified current.
- All fixes applied and verified: npm run quality exit 0 (build claude+kimi plugins, check:agents clean after fixing the generated mirror the right way — edited src/generation/fragments/opencode-agent-orchestrator.md + npm run generate:agents, check:versions, lint, tests, coverage, mdocs:validate). The 5 remaining validate warnings are pre-existing graph gaps unrelated to this initiative. Stable wiki learning recorded: docs/surface-release-docs-checklist.
- [2026-09-16T19:33:11.443Z] Marked done via mdocs command

## Artifacts
