---
id: "wiki-ingest-and-compiled-knowledge-model"
title: "wiki.ingest command + overview/repos/systems modeling"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["core","wiki","ingest","overview","compiled-knowledge","0.5.0"]
related_wiki: []
---

## Objective
Add a wiki.ingest command that synthesizes initiative artifacts into curated wiki pages including an overview.md dashboard, repos/ entity pages, systems/ entity pages, a grouped index.md, and an append-only log.md in directory-v2 layouts.

## Plan
- [ ] Design and record the wiki.ingest payload and overview.md/log.md section grammar
- [ ] Add wiki.ingest to supportedCommands and handler in src/core/commands/registry.ts composing existing wiki.* and new editors under withLock
- [ ] Extend src/core/managers/wiki.ts with updateOverviewSection and appendLog helpers that respect wikiIndexOwner/wikiIndexMode from src/core/contract.ts
- [ ] Add repo/system stub templates and recognize them in wiki.stub and wiki.create
- [ ] Expose wiki.ingest via MCP in src/surfaces/claude-code/mcp-server.ts and CLI in src/cli/index.ts
- [ ] Update mdocs-orchestrator and mdocs-workflow skills to use wiki.ingest at REPORT
- [ ] Mirror the command in OpenCode src/surfaces/opencode/tools.ts and Codex surfaces
- [ ] Add directory-v2 fixture proving index.md stays byte-stable when owner external and updates when owner harness

## Context
Source: Gap Closure Spec (0.4.3 / 0.5.0) G2. `registry.ts` exposes `wiki.create/update/stub/delete/list/link/xref` and `index.sync` but no `ingest`. There is no first-class concept of `overview.md`, `repos/<repo>.md`, `systems/<system>.md`, grouped `index.md`, or append-only `log.md`. Hotspots: `src/core/commands/registry.ts`, `src/core/managers/wiki.ts`, `src/core/contract.ts`, `src/surfaces/claude-code/mcp-server.ts`, `src/cli/index.ts`, and the `mdocs-orchestrator`/`mdocs-workflow` skills.

## Acceptance Criteria
- One `wiki.ingest` call upserts the initiative page, applies repo/system edits with auto-stubbing, reflects status in `overview.md`, and appends to `log.md`.
- Directory-v2 canonical lowercase `index.md` stays byte-stable when `wikiIndexOwner` is `external` and regenerates only when opt-in `harness`.
- MCP `mdocs_ingest` and CLI `mdocs wiki ingest` both work.
- No auto-generated synthesis prose; all prose edits are recorded as caller-supplied operations.

## Progress Log
- [2026-06-23T03:37:50.324Z] Created initiative via mdocs command

## Artifacts
