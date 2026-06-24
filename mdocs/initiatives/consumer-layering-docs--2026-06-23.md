---
id: "consumer-layering-docs"
title: "Workspace-glue / layering documentation"
status: "done"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["docs","integration","layering","0.4.3"]
related_wiki: ["reference/consumer-layering"]
priority: "medium"
---

## Objective
Document how consumers can layer workspace-specific conventions over the generic harness-mdocs plugin without conflicting with its hooks, skills, or CLAUDE.md snippet.

## Plan
- [ ] Add docs/consumer-layering.md covering composition with a sibling knowledge base and external task list
- [ ] Document how consumer SessionStart hooks interact with the G1 SessionStart orientation hook
- [ ] Document that assets/templates/claude-md-snippet.md is additive and how to extend it without breaking tool routing
- [ ] Link docs/consumer-layering.md from README.md

## Progress Log
- [2026-06-23T03:38:20.045Z] Created initiative via mdocs command
- [2026-06-23] G8 IMPLEMENTED + VERIFIED via writer (docs-only). New docs/consumer-layering.md: Core Design, Composition with Sibling Knowledge Base, External Task List Integration, Consumer SessionStart Hooks (composition with G1 orientation - concatenated additionalContext, keep compact, no order guarantee), CLAUDE.md Snippet is Additive (compose-into not replace; safe extension patterns; re-merge on upgrade), Summary. README link at L228. No src/ touched (composition is external - consumer own hooks/CLAUDE.md/sibling dirs; no package-internal edits instructed).
- [2026-06-23T18:49:51.410Z] Marked done via mdocs command

## Artifacts
