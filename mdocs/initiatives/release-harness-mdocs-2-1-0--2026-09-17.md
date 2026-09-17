---
id: "release-harness-mdocs-2-1-0"
title: "Release harness-mdocs 2.1.0"
status: "active"
created: "2026-09-17"
updated: "2026-09-17"
owner: ""
tags: ["release","2.1.0","kimi-code","packaging"]
related_wiki: ["release/tag-based-npm-publishing","release/version-stamping","docs/surface-release-docs-checklist","reference/kimi-code-surface"]
priority: "medium"
next_action: "Review release:check output, then present RC evidence for approval"
---

## Objective
Prepare and publish harness-mdocs 2.1.0 — the first release shipping the Kimi Code surface. Land the currently uncommitted kimi-code surface + version-stamping + docs work onto main, verify the full quality and release gates, bump version manifests to 2.1.0, and publish the audited tag, npm package, and GitHub Release after explicit approval. Follow the proven v2.0.0 release flow and its recorded process learnings (tag-based publishing, build-time version stamping, docs checklist).

## Plan
- [ ] 1. Verify working tree: inventory uncommitted changes (kimi-code surface, version stamping, docs manuals); confirm kimi-code-surface and verify-docs initiatives are done
- [ ] 2. Run full quality gate on the uncommitted tree: `npm run quality` (build, check:agents, check:versions, lint, tests, coverage, mdocs:validate) + `pack:check` tarball inspection; fix failures including CI-only risks recorded in release-2-0-0 (check:agents on fresh checkout, Linux path mocks, CI timeouts)
- [ ] 3. Review + commit pending work onto main in coherent commits (kimi-code surface, version stamping, docs, mdocs records)
- [ ] 4. Inventory changes since v2.0.0; classify additions/breaking changes (expect: kimi-code surface + minor; verify zero breaking)
- [ ] 5. Write changelog / release notes for 2.1.0; audit docs against surface-release-docs-checklist (README, user-manual, agent-manual, packaging-strategy)
- [ ] 6. Bump version to 2.1.0 (`npm version 2.1.0 --no-git-tag-version`; stamp-versions syncs plugin + marketplace manifests; verify `check:versions` clean)
- [ ] 7. Run full release gate: `npm run quality` + `npm run release:check` + `pack:check`; independent artifact review
- [ ] 8. Present release-candidate evidence; obtain explicit approval before push/tag/publish
- [ ] 9. Push main, wait for Release Check green, create + push annotated tag v2.1.0, approve release environment
- [ ] 10. Verify npm package 2.1.0 + GitHub Release; confirm installed tarball reports {version: 2.1.0}
- [ ] 11. Create stable `release/harness-mdocs-2-1-0` wiki learning, lifecycle.graduate, validate mdocs graph, mark initiative done

## Progress Log
- [2026-09-17T14:01:43.008Z] Created initiative via mdocs command
- Context gathered from prior releases. Key findings: (1) entire kimi-code surface + version-stamping + docs work is UNCOMMITTED on main — 2.1.0 must land it first; (2) release flow per release/tag-based-npm-publishing: bump package.json, push main, Release Check, push v2.1.0 tag, approve release env, npm + GitHub Release auto; (3) version stamping (release/version-stamping) now syncs plugin.json + marketplace.json from package.json at build time — verify kimi plugin manifest is covered; (4) CI risks from 2.0.0: check:agents on fresh checkout, Linux-only path mock failures, tight timeouts — all reportedly fixed, re-verify. Plan steps 1-2 written.
- Steps 1-6 done. Committed pending work in 3 commits (5a28eec feat kimi-code surface, 8a33348 mdocs records, 0086a00 fragment regen). v2.0.0..HEAD inventory: zero breaking changes — src/core, src/cli, api/index, existing surfaces untouched; additive only (kimi-code export, files entry, scripts). Docs audited vs surface-release-docs-checklist: README table/entry-points/tree/usage, user-manual 2.5, agent-manual, packaging-strategy all cover kimi-code; pins bumped to 2.1.0. Version bumped: package.json 2.1.0, stamped into claude plugin.json + kimi.plugin.json + marketplace.json. Added 2.0.0→2.1.0 upgrade note to user-manual. Running release:check now.

## Artifacts
