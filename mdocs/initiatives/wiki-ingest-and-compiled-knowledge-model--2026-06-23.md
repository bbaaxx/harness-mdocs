---
id: "wiki-ingest-and-compiled-knowledge-model"
title: "wiki.ingest command + overview/repos/systems modeling"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["core","wiki","ingest","overview","compiled-knowledge","0.5.0"]
related_wiki: []
priority: "medium"
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

## Progress Log
- [2026-06-23T03:37:50.324Z] Created initiative via mdocs command
- [2026-06-23] 0.4.3 checkpoint complete (G1/G3/G5/G6/G7/G8/G9 done, release:check green 330 tests). G2 is NEXT (0.5.0, largest gap). RECOMMENDED SPLIT into sub-initiatives before executing: G2a = overview.md/log.md section grammar + updateOverviewSection/appendLog helpers in wiki.ts (respect wikiIndexOwner/Mode from G5); G2b = wiki.ingest command in registry.ts (compose wiki.* under withLock, no auto-prose) + MCP mdocs_ingest + CLI; G2c = repo/system stub templates + wiki.stub/create recognition; G2d = skills (orchestrator/workflow use ingest at REPORT) + OpenCode/Codex mirror + dir-v2 byte-stable fixture. G4 depends on G2a (graduate moves overview sections + appends log.md). Start fresh session.

## Artifacts
