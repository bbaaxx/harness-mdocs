---
id: "g2c-repo-system-stub-templates"
title: "G2c repo/system stub templates + wiki.stub/create recognition"
status: "done"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["core","wiki","stubs","repos","systems","0.5.0","g2c"]
related_wiki: ["docs/repo-system-entity-templates"]
priority: "medium"
---

## Objective
Add first-class 'repos' and 'systems' entity categories with dedicated stub templates so directory-v2 entity pages have a consistent structure, and make wiki.stub / wiki.create recognize those categories to apply the right template automatically.

## Plan
- [ ] Add defaultRepoTemplate(title,id,date) and defaultSystemTemplate(title,id,date) to src/core/managers/wiki.ts: entity-oriented skeletons (Summary, Boundaries/Responsibilities, Dependencies, Owners/Links placeholders) with valid frontmatter.
- [ ] wiki.stub: when category ∈ {repos, systems} and no explicit template is passed, select the matching entity template instead of the generic defaultStubTemplate.
- [ ] wiki.create: pass-through (content is caller-supplied) but ensure category recognition does not break existing behavior.
- [ ] Tests in tests/core: stub repos/<id> produces repo template; systems/<id> produces system template; other categories unchanged; create still accepts arbitrary content.

## Progress Log
- [2026-06-23T19:31:50.661Z] Created initiative via mdocs command
- [2026-06-23T19:57:16.239Z] Marked done via mdocs command

## Artifacts
