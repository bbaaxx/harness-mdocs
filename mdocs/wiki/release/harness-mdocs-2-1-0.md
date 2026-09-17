---
id: "harness-mdocs-2-1-0"
title: "harness-mdocs 2.1.0"
category: "release"
created: "2026-09-17"
updated: "2026-09-17"
related_initiatives: ["release-harness-mdocs-2-1-0"]
tags: ["release","2.1.0","kimi-code"]
---

# harness-mdocs 2.1.0

Released 2026-09-17. Tag `v2.1.0` (231a9a6), npm `harness-mdocs@2.1.0`, GitHub Release auto-created by `publish.yml`.

## Shipped

- **Kimi Code surface** — first release shipping it. `harness-mdocs/kimi-code` export; runtime (translate/hooks/orientation/adapter/MCP re-export); plugin at `src/surfaces/kimi-code/plugin` (`kimi.plugin.json` + esbuild-bundled hooks/MCP server); canonical 13-tool parity (`tests/surfaces/parity.test.ts`); generation fragments with managed dogfood outputs under `.kimi-code/`; docs in `docs/kimi-code.md` plus README/user-manual/agent-manual/packaging-strategy updates.
- **Build-time version stamping** — `scripts/stamp-versions.js` stamps `package.json` version into the claude plugin.json, `kimi.plugin.json`, and `marketplace.json`; `check:versions` guards drift in `quality`. First release using it end to end; no manual manifest edits.

## Compatibility

Zero breaking changes, purely additive (verified: `src/core`, `src/cli`, `src/api.ts`, `src/index.ts`, and all pre-existing surfaces byte-unchanged vs v2.0.0; no dependency changes). Upgrade guide: install 2.1.0, nothing else changes. See upgrade notes in `docs/user-manual.md` §6.

## Process notes

- The kimi-code surface work landed uncommitted on main; release prep committed it first (feat + mdocs records + fragment regen), then bumped.
- First Publish run failed on the known CI-only flake `tests/agents/run-authority-persistence.test.ts` (`manager-hung-settlement` commit assertion on 2-core runners, suite ~157s); rerun passed. Third consecutive release where a publish needed a rerun — the test remains a release-train risk worth hardening.
- Version stamping worked as designed: one `npm version` + build stamped all three manifests; `check:versions` clean locally and in CI.
