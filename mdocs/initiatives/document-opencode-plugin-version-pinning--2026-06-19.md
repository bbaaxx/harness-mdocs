---
id: "document-opencode-plugin-version-pinning"
title: "Document OpenCode plugin version pinning"
status: "done"
created: "2026-06-19"
updated: "2026-06-19"
owner: ""
tags: ["docs","readme","opencode","migration"]
related_wiki: ["docs/opencode-plugin-version-pinning"]
priority: "medium"
---

## Objective
Add README guidance for OpenCode users migrating to harness-mdocs 0.4.0, recommending pinned plugin versions and cache cleanup when @latest remains stale.

## Plan
- [x] Update README OpenCode usage with pinned version recommendation.
- [x] Document cache cleanup and verification path for stale `@latest` installs.
- [x] Validate docs and mdocs state.

## Progress Log
- [2026-06-19T18:57:48.688Z] Created initiative via mdocs command
- Updated README OpenCode Usage to recommend pinned npm plugin config (`harness-mdocs@0.4.0`), document stale `@latest` cache cleanup for `~/.cache/opencode/packages/`, provide a version verification command, and clarify that pinned package root loads the OpenCode surface by default. Verified with git diff --check and mdocs_validate.
- [2026-06-19T19:00:43.319Z] Marked done via mdocs command

## Artifacts
- README.md