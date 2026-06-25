---
id: "fix-initiative-index-validation-false-positive"
title: "Fix initiative INDEX validation false positives for markdown filenames in titles"
status: "active"
created: "2026-06-25"
updated: "2026-06-25"
owner: ""
tags: ["validation","initiatives","index","bug","mdocs"]
related_wiki: []
---

## Objective
Fix the initiative INDEX validator so it only validates actual initiative filename fields, not arbitrary `.md` tokens that appear in initiative titles such as `overview.md`, `log.md`, or `index.md`. Eliminate the current false warnings while preserving detection of genuinely missing initiative files.

## Plan


## Progress Log
- [2026-06-25T12:57:19.061Z] Created initiative via mdocs command

## Artifacts
