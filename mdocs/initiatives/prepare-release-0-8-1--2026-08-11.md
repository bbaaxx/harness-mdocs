---
id: "prepare-release-0-8-1"
title: "Prepare release 0.8.1"
status: "done"
created: "2026-08-11"
updated: "2026-08-11"
owner: "openagent"
tags: ["release","0.8.1","npm","github-actions","github-issue-8"]
related_wiki: ["release/harness-mdocs-0-8-1"]
priority: "medium"
handoff_summary: "0.8.1 release prep ready. Four manifests synchronized, generated Claude plugin refreshed, stable release notes recorded, release:check passed, package verified unpublished, final review found no issues."
next_action: "Await explicit approval to commit release preparation; push and tag remain separate approvals."
---

## Objective
Prepare harness-mdocs 0.8.1 compatibility patch: synchronize release metadata, document issue #8 regression fix, pass full release checks, and produce a release-ready worktree without pushing or tagging.

## Plan
- [ ] Inspect current branch, release workflow, prior 0.8.0 artifacts, and version-bearing manifests.
- [ ] Bump package, lockfile, Claude plugin, and marketplace versions to 0.8.1; add release notes.
- [ ] Run npm run release:check and verify package contents/version consistency.
- [ ] Review release diff and resolve any failures or packaging regressions.
- [ ] Record release evidence and leave commit/tag/push for explicit approval.

## Progress Log
- [2026-08-11T02:52:20.557Z] Created initiative via mdocs command
- Confirmed repository release process: four version-bearing manifests, npm run release:check gate, main push Release Check workflow, and explicit tag push for npm/GitHub publication. Publication remains out of scope pending separate approval.
- Synchronized package, lockfile, Claude plugin, and marketplace versions to 0.8.1. Drafted release notes describing issue #8 compatibility correction and preserved diagnostics.
- Full npm run release:check passed for 0.8.1: 45 suites/502 tests, coverage 91.14% statements and 81.01% branches, mdocs valid=true with one pre-existing warning, package dry-run 298 files / 832.8 kB / 5.0 MB. Version consistency passed; 0.8.1 remains unpublished. Generated Claude plugin runtime refreshed from fixed source.
- Independent final release diff review found no issues. Release worktree is ready for a chore(release) commit; no push, tag, or publication performed.
- [2026-08-11T02:57:51.758Z] Marked done via mdocs command

## Artifacts
