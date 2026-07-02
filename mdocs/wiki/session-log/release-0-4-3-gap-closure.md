---
id: "release-0-4-3-gap-closure"
title: "0.4.3 gap-closure milestone"
category: "session-log"
created: "2026-06-23"
updated: "2026-06-23"
related_initiatives: ["close-harness-mdocs-gaps"]
tags: ["session-log","release","0.4.3","gap-closure"]
---

# 0.4.3 gap-closure milestone (2026-06-23)

Session executed the harness-mdocs 0.4.3 gap-closure plan (7 gaps). All done + verified.

## Shipped (0.4.3)
- **G1** SessionStart + PreCompact orientation hooks (stdout `additionalContext` JSON, fail-open). Wiki: [[sessionstart-orientation-hook]].
- **G3** Configurable enforcement: deleted destructive-bash gate (Write/Edit-only), `mdocs.enforcement.idle` (readonly/open, default open), enforcement mode (gate/advisory/off), `mdocs_reset`, `resume()` auto-reset. Driven by the G7 dogfood friction log F1-F9 decisions. Wiki: [[workflow-enforcement-dogfood-friction-log]].
- **G5** Wiki index ownership opt-in (`canonical-lowercase` + `wikiIndexOwner: harness`), default external=no-op. Wiki: [[wiki-index-ownership]].
- **G6** Unified project-root resolution (`resolveProjectRoot`: MDOCS_PROJECT_DIR > walk-up > cwd) across MCP + hooks. Wiki: [[project-root-resolution]].
- **G7** End-to-end enforcement dogfood (drove G9 through all 9 steps; friction log F1-F9).
- **G8** Consumer layering docs (`docs/consumer-layering.md`). Wiki: [[consumer-layering]].
- **G9** Removed self-referential `harness-mdocs` devDep.

## Verification
- `npm run release:check` RC_EXIT=0 (build:plugin + lint + test + coverage + mdocs:validate + pack).
- 330 tests, 30 suites.
- `mdocs_validate` valid:true (only pre-existing initiatives/INDEX.md drift remains = data hygiene, out of gap scope).
- All defaults non-breaking (0.4.2 behavior preserved).

## Next (0.5.0)
- **G2** wiki.ingest + compiled-knowledge model (overview.md/repos/systems/log.md). LARGEST; split recommended (G2a grammar/helpers, G2b command+MCP/CLI, G2c stubs, G2d skills/mirror). See initiative.
- **G4** lifecycle parity (complete state, expectedDuration, graduate, 3 lint rules). Depends on G2a.

## Status
All 0.4.3 changes are in the working tree, uncommitted (user checkpointed without commit). `dist/` rebuilt so live hooks reflect 0.4.3. Workflow state reset to IDLE for the next session.
