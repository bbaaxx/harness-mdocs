---
id: "close-harness-mdocs-gaps"
title: "Close harness-mdocs 0.4.3 / 0.5.0 gaps"
status: "active"
created: "2026-06-23"
updated: "2026-06-25"
owner: ""
tags: ["orchestrator","release","0.4.3","0.5.0","gap-closure"]
related_wiki: ["docs/gap-closure-orchestrator-prompt","session-log/release-0-4-3-gap-closure"]
priority: "medium"
---

## Objective
Orchestrate the closure of all nine gap initiatives for the 0.4.3 patch and 0.5.0 minor releases of harness-mdocs, following the spec sequencing and recording progress in each child initiative.

## Plan
- [ ] Read all nine gap initiatives in mdocs/initiatives/ and confirm their Acceptance Criteria
- [ ] Execute G7 dogfood first and record friction notes that feed into G3
- [ ] Land G6 and G9 changes with tests and updated docs
- [ ] Land G1 SessionStart orientation hook, G5 directory-v2 index opt-in, and G8 consumer layering docs
- [ ] Land G3 configurable enforcement using friction from G7
- [ ] Land G2 wiki.ingest and G4 lifecycle parity as the 0.5.0 semantic work
- [ ] Run npm run release:check and mdocs_validate before cutting each release

## Progress Log
- [2026-06-23T03:51:59.905Z] Created initiative via mdocs command
- Created orchestrator initiative and saved the master agent prompt to wiki docs/gap-closure-orchestrator-prompt.md.
- [2026-06-25] State healed: linked 0.4.3 gap-closure session log.

## Artifacts
