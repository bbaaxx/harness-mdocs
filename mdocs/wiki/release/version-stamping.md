---
id: "version-stamping"
title: "Build-time version stamping (plugin.json + marketplace.json)"
category: "release"
created: "2026-09-16"
updated: "2026-09-16"
related_initiatives: ["stamp-plugin-marketplace-versions-from-package-json-at-build-time","release-harness-mdocs-2-1-0"]
tags: ["release","build","drift"]
---

# Build-time version stamping

Initiative `stamp-plugin-marketplace-versions-from-package-json-at-build-time`. Fixes the v2.0.0 release pain of hand-editing three manifests.

## Design
- **Single source of truth:** `package.json` `version`.
- **`scripts/stamp-versions.js`** surgically rewrites the `"version"` value (regex on the field, formatting preserved, idempotent — no write when in sync) in:
  - `src/surfaces/claude-code/plugin/.claude-plugin/plugin.json`
  - `.claude-plugin/marketplace.json` (`plugins[].version`)
- Wired into `build` (after `write-build-info.js`), so `prepack`/`quality`/`release:check` inherit it.
- **`check:versions`** = `stamp-versions.js --check`: exit 1 + file list on drift, no writes. Added to `quality` (same pattern as `check:agents`).

## Verified
- Idempotent on sync tree (git stays clean).
- Perturbed plugin.json → `--check` exits 1 with clear message → stamp restores → clean.
- `npm run build` + full jest (65 suites / 1546 tests) pass.

## Notes
- Codex/pi surfaces carry no version fields — nothing to stamp there.
- Same drift-bug class as the gitSha finding; same fix pattern (build-time generation).