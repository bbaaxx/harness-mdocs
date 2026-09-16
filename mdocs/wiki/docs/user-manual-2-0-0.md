---
id: "user-manual-2-0-0"
title: "User Manual for harness-mdocs 2.0.0"
category: "docs"
created: "2026-09-16"
updated: "2026-09-16"
related_initiatives: ["user-and-agent-manuals-for-harness-mdocs-2-0-0"]
tags: ["docs","manual","2.0.0"]
---

# User Manual (docs/user-manual.md)

Human-facing manual for harness-mdocs 2.0.0, written under initiative `user-and-agent-manuals-for-harness-mdocs-2-0-0`.

## Covers
- Concepts: initiatives vs wiki, Markdown + frontmatter, runtime files
- Install per surface: OpenCode (opencode.json), Claude Code (plugin + manual fallback), Codex v1 (CLI, advisory), pi (extension)
- Workflow steps UNDERSTAND..COMPLETE + why Write/Edit gating exists
- CLI reference (`mdocs` binary; commands verified against src/cli + registry.ts)
- Config: `.mdocs.json`, `MDOCS_ENFORCEMENT` (gate|advisory|off), `MDOCS_ENFORCEMENT_IDLE` (open|readonly), precedence env > file > detected contract
- Upgrade: 2.0.0 zero breaking changes (per release/v2-0-0-migration-matrix)
- Troubleshooting: stale session tools, blocked edits, build fingerprint, index drift

## Provenance
459 lines. All command names verified against `src/cli/index.ts` + `src/core/commands/registry.ts`; step names and gate semantics against `src/core/workflow/engine.ts`.