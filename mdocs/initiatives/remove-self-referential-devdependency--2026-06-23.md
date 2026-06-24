---
id: "remove-self-referential-devdependency"
title: "Package hygiene: self-referential devDependency"
status: "done"
created: "2026-06-23"
updated: "2026-06-23"
owner: ""
tags: ["packaging","hygiene","dependencies","0.4.3"]
related_wiki: ["docs/self-referential-devdependency-hygiene"]
priority: "medium"
---

## Objective
Remove the self-referential harness-mdocs devDependency from package.json and confirm the build, tests, and release checks remain clean.

## Plan
- [ ] Remove the harness-mdocs entry from package.json devDependencies
- [ ] Confirm no test or build file imports the package by its published name
- [ ] Run npm run quality and confirm it passes
- [ ] Run npm run release:check and confirm it passes

## Progress Log
- [2026-06-23T03:38:23.889Z] Created initiative via mdocs command
- [2026-06-23T04:07:47.451Z] bash executed at step UNDERSTAND
- [2026-06-23T04:08:06.065Z] bash executed at step UNDERSTAND
- [2026-06-23T04:08:54.738Z] bash executed at step CONTEXT
- [2026-06-23T04:09:23.996Z] edit executed at step PLAN
- [2026-06-23T04:10:23.743Z] bash executed at step VERIFY
- [2026-06-23T04:10:44.844Z] bash executed at step VERIFY
- [2026-06-23T04:10:52.640Z] bash executed at step VERIFY
- [2026-06-23T04:13:18.495Z] write executed at step VERIFY
- [2026-06-23T04:13:30.576Z] write executed at step VERIFY
- [2026-06-23T04:14:39.264Z] bash executed at step VERIFY
- [2026-06-23T04:15:33.253Z] write executed at step VERIFY
- [2026-06-23T04:15:40.110Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.119Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.126Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.140Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.155Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.171Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.187Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.202Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.220Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.235Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.250Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.265Z] edit executed at step VERIFY
- [2026-06-23T04:15:40.308Z] bash executed at step VERIFY
- [2026-06-23T04:16:19.184Z] bash executed at step VERIFY
- [2026-06-23T04:17:05.196Z] bash executed at step VERIFY
- [2026-06-23T04:18:53.157Z] bash executed at step COMPLETE
- [2026-06-23T04:19:30.990Z] bash executed at step COMPLETE
- [2026-06-23T04:21:43.576Z] Marked done via mdocs command

## Artifacts
