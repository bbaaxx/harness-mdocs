---
id: "consumer-layering-docs"
title: "Workspace-glue / layering documentation"
status: "active"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["docs","integration","layering","0.4.3"]
related_wiki: []
---

## Objective
Document how consumers can layer workspace-specific conventions over the generic harness-mdocs plugin without conflicting with its hooks, skills, or CLAUDE.md snippet.

## Plan
- [ ] Add docs/consumer-layering.md covering composition with a sibling knowledge base and external task list
- [ ] Document how consumer SessionStart hooks interact with the G1 SessionStart orientation hook
- [ ] Document that assets/templates/claude-md-snippet.md is additive and how to extend it without breaking tool routing
- [ ] Link docs/consumer-layering.md from README.md

## Context
Source: Gap Closure Spec (0.4.3 / 0.5.0) G8. The package is generic; real consumers add workspace layers such as sibling shared knowledge bases, external task lists, and house authoring rules. There is currently no guidance on composing these with the plugin's hooks, skills, or `assets/templates/claude-md-snippet.md`. This overlaps with G1 because consumer SessionStart hooks must compose with the new orientation hook.

## Acceptance Criteria
- `docs/consumer-layering.md` exists and explains how to layer a sibling knowledge base and external task list over harness-mdocs.
- Document explains how consumer SessionStart hooks compose with the G1 orientation hook without duplicate or conflicting context.
- Document explains that `assets/templates/claude-md-snippet.md` is additive and shows safe extension patterns.
- README links to the new doc.

## Progress Log
- [2026-06-23T03:38:20.045Z] Created initiative via mdocs command

## Artifacts
