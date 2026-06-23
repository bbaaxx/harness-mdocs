---
id: "configurable-workflow-enforcement"
title: "Enforcement opt-in config + git-gating reconsidered"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["claude-code","workflow","enforcement","config","hooks","0.4.3"]
related_wiki: []
---

## Objective
Add an enforcement compatibility setting with gate/advisory/off modes and a configurable git-gating flag so the workflow gate can be relaxed without changing default behavior for existing installs.

## Plan
- [ ] Add enforcement field to MdocsCompatibilityConfig and MdocsContract in src/core/contract.ts with default gate
- [ ] Thread enforcement mode into src/core/workflow/engine.ts canExecuteTool decisions
- [ ] Make the destructive-bash set configurable or split git mutations into an opt-in gitGating flag
- [ ] Surface the config via MCP environment and config file with documented precedence
- [ ] Update assets/templates/claude-md-snippet.md and mdocs-workflow skill documentation
- [ ] Add tests covering all three enforcement modes plus git-gating flag

## Context
Source: Gap Closure Spec (0.4.3 / 0.5.0) G3. `src/core/workflow/engine.ts` gates Write/Edit before PLAN and destructive Bash (including `git commit`/`git push`) before COMPLETE, but `MdocsCompatibilityConfig` in `src/core/contract.ts` has no enforcement field to relax this. Hotspots: `src/core/workflow/engine.ts`, `src/core/contract.ts`, `assets/templates/claude-md-snippet.md`, and `.claude/skills/mdocs-workflow/SKILL.md`.

## Acceptance Criteria
- `enforcement: 'gate' | 'advisory' | 'off'` is supported with default `gate` so existing installs behave exactly like 0.4.2.
- `off` allows Write/Edit and `git commit` at any non-IDLE step; `advisory` allows but warns without exit 2.
- `gitGating` is configurable independently from general destructive-bash gating.
- Config precedence (env vs file vs detected contract) is documented and tested.

## Progress Log
- [2026-06-23T03:37:55.527Z] Created initiative via mdocs command

## Artifacts
