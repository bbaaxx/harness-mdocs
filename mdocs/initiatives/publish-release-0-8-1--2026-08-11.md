---
id: "publish-release-0-8-1"
title: "Publish release 0.8.1"
status: "active"
created: "2026-08-11"
updated: "2026-08-11"
owner: "openagent"
tags: ["release","0.8.1","npm","github-actions","publishing"]
related_wiki: ["release/harness-mdocs-0-8-1"]
priority: "medium"
next_action: "Run final publication preflight, commit release preparation, and push main."
---

## Objective
Commit and push prepared 0.8.1 release, verify main release gate, push v0.8.1 tag to trigger publication, and confirm npm package plus GitHub Release.

## Plan
- [ ] Run final git/version/tag/registry preflight and ensure only intended release files are included.
- [ ] Commit release preparation and push main.
- [ ] Wait for GitHub Release Check workflow success on release commit.
- [ ] Create and push annotated v0.8.1 tag.
- [ ] Wait for Publish workflow success; verify npm latest/version and GitHub Release.
- [ ] Record publication evidence and complete initiative.

## Progress Log
- [2026-08-11T05:05:43.512Z] Created initiative via mdocs command
- User explicitly approved commit, main push, v0.8.1 tag creation, and tag push to trigger npm/GitHub publication.

## Artifacts
