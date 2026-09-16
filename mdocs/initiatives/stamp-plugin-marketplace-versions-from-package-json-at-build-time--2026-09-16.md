---
id: "stamp-plugin-marketplace-versions-from-package-json-at-build-time"
title: "Stamp plugin + marketplace versions from package.json at build time"
status: "active"
created: "2026-09-16"
updated: "2026-09-16"
owner: ""
tags: ["release","build","drift","tech-debt"]
related_wiki: []
---

## Objective
Eliminate manual version duplication across manifests. v2.0.0 release required hand-editing package.json, src/surfaces/claude-code/plugin/.claude-plugin/plugin.json, and .claude-plugin/marketplace.json — same class of drift bug as the gitSha finding (fixed via build-time stamping). Goal: single source of truth (package.json version), everything else stamped or validated at build/release time.

## Plan


## Progress Log
- [2026-09-16T05:57:46.087Z] Created initiative via mdocs command

## Artifacts
