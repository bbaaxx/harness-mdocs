---
id: "g2b-wiki-ingest-command-and-surfaces"
title: "G2b wiki.ingest command + MCP/CLI surfaces + withLock promotion"
status: "done"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["core","wiki","ingest","mcp","cli","0.5.0","g2b"]
related_wiki: ["docs/wiki-ingest-command"]
priority: "medium"
---

## Objective
Add a wiki.ingest command that records caller-supplied operations and applies them as one atomic multi-file write composed from existing wiki.* primitives plus the G2a overview/log helpers, wrapped in withLock. Expose via MCP (mdocs_ingest) and CLI. Promote withLock from the claude-code surface into src/core/lock.ts so core/registry can use it. CRITICAL: ingest NEVER auto-generates synthesis prose — it only records and applies exactly what the caller supplies (the agent authors all prose).

## Plan
- [ ] Promote withLock from src/surfaces/claude-code/lock.ts into src/core/lock.ts (move impl; surface re-exports to keep the hooks' import path stable).
- [ ] Add 'wiki.ingest' to MdocsCommandRegistry.supportedCommands + execute() handler.
- [ ] Handler accepts { operations: WikiIngestOp[], note? }. Operations are caller-authored variants: create/update a wiki page, updateOverviewSection, appendLog, link. Apply sequentially under withLock(mdocsRoot, 'wiki-ingest'); return a manifest { applied, changedFiles } recording what happened. No prose generation anywhere in the path.
- [ ] Add MCP tool mdocs_ingest in src/surfaces/claude-code/mcp-server.ts; add a wiki.ingest help example in src/cli/index.ts (the generic 'command <name>' path already dispatches it).
- [ ] Tests in tests/core: ingest applies a batch atomically; respects external owner (no-op on index.md); output contains only caller-supplied text (no-prose assertion); withLock serializes concurrent ingests (two batches, both applied, no lost write).

## Progress Log
- [2026-06-23T19:31:32.156Z] Created initiative via mdocs command
- [2026-06-23T19:53:18.382Z] Marked done via mdocs command

## Artifacts
