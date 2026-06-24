---
id: "g2a-overview-log-grammar-and-helpers"
title: "G2a overview.md/log.md section grammar + wiki.ts helpers"
status: "done"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["core","wiki","ingest","compiled-knowledge","0.5.0","g2a"]
related_wiki: ["docs/compiled-knowledge-overview-log-grammar"]
priority: "medium"
---

## Objective
Define and implement the overview.md (dashboard) and log.md (append-only) section grammar for directory-v2 wiki layouts, and add WikiManager.updateOverviewSection() + WikiManager.appendLog() helpers. These are harness-owned compiled views, produced only in directory-v2 (canonical-lowercase) mode. They must NEVER touch the externally-owned wiki/index.md. Foundation for G2b (ingest) and G4 (graduate moves overview sections + appends log.md). Do NOT auto-generate prose.

## Plan
- [ ] Document overview.md + log.md section grammar: overview.md = single H1 + named H2 sections keyed by section name, each independently replaceable; log.md = H1 + chronologically appended timestamped blocks. Record grammar in this initiative and later in a stable wiki entry.
- [ ] Add updateOverviewSection(section: string, body: string) to src/core/managers/wiki.ts: create wiki/overview.md (H1 '# Overview') if absent; idempotently replace the named '## <section>' block or insert it before any trailing sections; preserve all other sections byte-for-byte; update updated frontmatter date.
- [ ] Add appendLog(entry) to src/core/managers/wiki.ts: append a timestamped block to wiki/log.md (create H1 '# Log' if absent); preserve existing entries; never reorder.
- [ ] Gate both helpers on directory-v2 mode (canonical-lowercase): no-op (return null/empty) outside it. Verify neither writes wiki/index.md regardless of wikiIndexOwner.
- [ ] Unit tests in tests/core/wiki.test.ts (or new overview-log.test.ts): section replace vs insert, multi-section preservation, append ordering + idempotency, dir-v2-only gating, index.md untouched.

## Progress Log
- [2026-06-23T19:31:20.684Z] Created initiative via mdocs command
- [2026-06-23T19:44:07.795Z] Marked done via mdocs command

## Artifacts
