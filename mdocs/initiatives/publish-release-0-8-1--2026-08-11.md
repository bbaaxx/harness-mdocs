---
id: "publish-release-0-8-1"
title: "Publish release 0.8.1"
status: "done"
created: "2026-08-11"
updated: "2026-08-11"
owner: "openagent"
tags: ["release","0.8.1","npm","github-actions","publishing"]
related_wiki: ["release/harness-mdocs-0-8-1"]
priority: "medium"
handoff_summary: "0.8.1 published successfully. Commit 3859047, annotated tag v0.8.1, Release Check 31460733569 and Publish 31460827157 succeeded; npm latest=0.8.1; GitHub Release live."
next_action: "Publication complete; retain release evidence and monitor issue #8 consumer confirmation."
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
- Published harness-mdocs 0.8.1. Release commit 3859047 pushed to main; GitHub Release Check 31460733569 succeeded; annotated v0.8.1 tag pushed; Publish workflow 31460827157 succeeded. npm registry confirms harness-mdocs@0.8.1 and latest=0.8.1. GitHub Release: https://github.com/bbaaxx/harness-mdocs/releases/tag/v0.8.1.
- [2026-08-11T05:13:37.102Z] Marked done via mdocs command

## Artifacts
