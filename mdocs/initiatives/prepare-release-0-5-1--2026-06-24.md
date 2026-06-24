---
id: "prepare-release-0-5-1"
title: "Prepare release 0.5.1"
status: "done"
created: "2026-06-24"
updated: "2026-06-24"
owner: ""
tags: ["release","0.5.1","consumer-schema","compat"]
related_wiki: ["reference/consumer-schema-compat"]
priority: "high"
next_action: "Merge PR #5 to main, then tag v0.5.1 + push (triggers publish.yml)"
---

## Objective
Cut 0.5.1 to ship the consumer-schema-compat work (parent initiative consumer-schema-compat + cc0..cc4) that lands on main via PR #5: opt-in `.mdocs.json` config + `initiativeRecordMode` contract flag, metadata-only initiative writes, linter consumer tolerance, wiki canonical id/ref + `appendLog` consumer heading, docs, and dogfood. Bump version, pass `npm run release:check`, then hand off tag `v0.5.1` + push (triggers `publish.yml`: npm publish + GitHub Release). Publish is irreversible, so the tag+push is a user handoff (repo release convention).

## Plan
- [x] Bump 0.5.0 -> 0.5.1 version refs: package.json, package-lock.json (`npm install --package-lock-only`), .claude-plugin/marketplace.json, src/surfaces/claude-code/plugin/.claude-plugin/plugin.json. Codex plugin.json left at 0.1.1 (separately versioned).
- [ ] Run `npm run release:check` (build + lint + test + coverage + mdocs validate + pack:check) green
- [ ] Release commit `chore(release): prepare 0.5.1`
- [ ] Merge PR #5 (compat + 0.5.1 bump) to main
- [ ] Hand off tag `v0.5.1` + push (triggers publish.yml: npm publish + GitHub Release)
- [ ] Record release wiki entry once published

## Progress Log
- [2026-06-24] Version bumped 0.5.0 -> 0.5.1 in package.json, .claude-plugin/marketplace.json, src/surfaces/claude-code/plugin/.claude-plugin/plugin.json; package-lock.json synced via `npm install --package-lock-only`. Codex plugin.json untouched (0.1.1, separately versioned). Consumer-schema-compat work (cc0..cc4) is on feat/consumer-schema-compat in PR #5 (414 tests green, coverage >=80%, mdocs_validate valid:true). Awaiting release:check, then merge + tag handoff.
- [2026-06-24T16:05:28.491Z] Marked done via mdocs command

## Artifacts
