---
id: "cc4-docs-and-dogfood"
title: "cc4 docs (.mdocs.json + initiativeRecordMode) and package dogfood"
status: "active"
created: "2026-06-24"
updated: "2026-06-24"
owner: ""
tags: ["docs","dogfood","compat","release"]
related_wiki: ["reference/consumer-layering"]
priority: "medium"
---

## Objective
Document the new `.mdocs.json` config file and `initiativeRecordMode`, correct the "file" precedence claim, and dogfood the work in the package's own `mdocs/`. Final integration gate before the PR.

## Plan
- [ ] Update `src/surfaces/claude-code/assets/templates/claude-md-snippet.md` and the plugin `CLAUDE.md` to document `.mdocs.json` (compatibility, standaloneCategories) and `initiativeRecordMode`, making the env > file > default precedence true.
- [ ] Update `README.md` and `docs/consumer-layering.md` with a consumer-schema-compat section and an example `.mdocs.json`.
- [ ] Dogfood: record this initiative set in `mdocs/initiatives/`, run a `wiki.ingest` capturing the consumer-compat model into `mdocs/wiki/`, append a session-log entry.
- [ ] Run the full gate: `npm run build && npm run build:claude-plugin && npm test && npm run coverage && npm run mdocs:validate`.

## Acceptance Criteria
- Docs describe `.mdocs.json` + `initiativeRecordMode` accurately; full gate green; dogfood initiative + wiki entry present.

## Progress Log
- [2026-06-24] IMPLEMENTED. Documented `.mdocs.json` + `initiativeRecordMode` in claude-md-snippet.md, CLAUDE.md, README.md (new Consumer Schema Compatibility section), docs/consumer-layering.md (new section); corrected precedence wording to env > `.mdocs.json` file > detected contract. Dogfooded: created mdocs/wiki/reference/consumer-schema-compat.md (lifecycle stable, backlinks to parent) + mdocs/wiki/session-log/consumer-schema-compat.md via wiki.create; index.sync + mdocs_validate valid:true.

## Artifacts
