---
id: "dogfood-local-opencode-plugin"
title: "Dogfood local OpenCode plugin build"
status: "done"
created: "2026-07-03"
updated: "2026-07-03"
owner: ""
tags: ["opencode","dogfood","plugin","config"]
related_wiki: []
priority: "medium"
---

## Objective
Point this repository's OpenCode config at the local built harness-mdocs OpenCode plugin instead of a stale published npm plugin, so validation/tools dogfood current checkout behavior.

## Plan


## Progress Log
- [2026-07-03T19:56:34.800Z] Created initiative via mdocs command
- Updated `.opencode/opencode.jsonc` to load local built plugin `../dist/surfaces/opencode/opencode.js` instead of stale published `harness-mdocs@0.4.0`. Verified JSON parse and target exists. Built CLI validation is clean with 0 warnings.
- [2026-07-03T19:57:16.241Z] Marked done via mdocs command

## Artifacts
