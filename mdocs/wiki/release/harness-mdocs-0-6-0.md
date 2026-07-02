---
id: "harness-mdocs-0-6-0"
title: "harness-mdocs 0.6.0"
category: "release"
created: "2026-06-26"
updated: "2026-06-26"
related_initiatives: ["add-pi-surface","prepare-release-0-6-0"]
tags: ["release","0.6.0","pi","surface","packaging"]
---

# harness-mdocs 0.6.0

Minor release for the first-class pi surface and staged release train updates.

## Added
- pi package surface under `harness-mdocs/pi` with extension entrypoint, mdocs custom tools, workflow gate, audit/progress handling, session orientation, and bundled pi skills.
- pi docs in `docs/pi-surface.md` plus README and packaging strategy updates.
- Project-scoped pi dogfood settings and generated pet assets included in the staged branch.

## Included Since 0.5.3
- Claude Code plugin bundle updates that keep the MCP server self-contained in plugin cache installs.
- Consumer schema compatibility and release memory cleanup already merged through staging.

## Verification
- `npm run release:check` passed.
- 459 Jest tests passed.
- Coverage passed.
- `mdocs_validate` valid:true with known initiative-index warnings for overview/log/index pseudo-links.
- `npm pack --dry-run` produced `harness-mdocs-0.6.0.tgz` with 298 files, 765.4 kB package size, 4.7 MB unpacked size.

## Publish Handoff
- After merge to `main`, tag `v0.6.0` and push the tag to trigger `publish.yml`.
