---
id: "g2d-ingest-skills-mirrors-and-fixture"
title: "G2d ingest skills + OpenCode/Codex mirror + dir-v2 byte-stable fixture"
status: "done"
created: "2026-06-23"
updated: "2026-06-24"
owner: ""
tags: ["core","wiki","ingest","skills","opencode","codex","fixtures","0.5.0","g2d"]
related_wiki: ["docs/wiki-ingest-surface-coverage"]
priority: "medium"
---

## Objective
Wire wiki.ingest into the consumer skills (use at REPORT), mirror the command in the OpenCode and Codex surfaces, and add a directory-v2 fixture proving index.md is byte-stable when owner=external and regenerated when owner=harness, with overview.md/log.md produced by ingest. Closes the G2 parent gap.

## Plan
- [ ] Update skills/mdocs-workflow + skills/mdocs-initiative (and .claude/skills/mdocs-orchestrator) to instruct calling wiki.ingest at REPORT with caller-authored operations instead of hand-authoring scattered wiki pages.
- [ ] Mirror wiki.ingest in src/surfaces/opencode/tools.ts and the Codex surface command surface so non-Claude harnesses get the same command.
- [ ] Add a tests/fixtures/directory-v2-mdocs-based ingest fixture + test: snapshot index.md bytes under owner=external → ingest leaves it identical; under owner=harness → index.md regenerates; overview.md + log.md appear in both owner modes (harness-owned compiled views).
- [ ] Mark parent G2 (wiki-ingest-and-compiled-knowledge-model) done after this lands; link the stable wiki entry bidirectionally.

## Progress Log
- [2026-06-23T19:32:06.661Z] Created initiative via mdocs command
- [2026-06-24T00:53:43.284Z] Marked done via mdocs command

## Artifacts
