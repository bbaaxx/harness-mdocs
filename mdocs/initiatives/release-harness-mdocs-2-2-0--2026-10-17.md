---
id: "release-harness-mdocs-2-2-0"
title: "Release harness-mdocs 2.2.0"
status: "done"
created: "2026-10-17"
updated: "2026-10-17"
owner: ""
tags: ["release","2.2.0","npm","github-actions","bugfix"]
related_wiki: ["release/tag-based-npm-publishing","release/version-stamping","docs/surface-release-docs-checklist","architecture/mutation-and-surface-boundary-hardening","release/harness-mdocs-2-2-0"]
phase: "done"
next_action: "Monitor open issue confirmations; Kimi users must reinstall the plugin and reload after upgrading."
priority: "high"
depends_on: ["address-open-issues-8-11"]
handoff_summary: "RELEASE COMPLETE: harness-mdocs 2.2.0 is npm latest, tag v2.2.0 targets 85a8464 (source 089815f). Release Check 39004256519 and Publish 39004522383 passed first attempts. Authored GitHub Release notes verified. Fresh registry install verified 96 signatures/12 attestations, tarball integrity, 620 files, CLI and bundled Claude/Kimi fingerprint 2.2.0/85a8464, correct project, canonical enum, rich CRLF preservation, no-mutation rejection and targeted registration/default read-only. Stable release wiki records evidence. Initiative is done and graduated; workflow COMPLETE. Mdocs-only closure records publication evidence without moving release tag. Release comments posted to #8–#11; all remain open for reporting-consumer/Kimi-host confirmation or deferred scope."
open_questions: []
blockers: []
graduated: "2026-10-17"
---

## Objective
Prepare the proposed 2.2.0 minor release containing fixes for issues #8–#11 and opt-in targeted compiled-view registration. Review and version the current uncommitted implementation, rerun final release/artifact gates, and publish only after explicit approval. Keep production Run plan-only and external compiled views read-only by default.

## Plan
- [x] Inventory pending changes and changes since v2.1.0; confirm 2.2.0 minor scope for issues #8–#11 and separate deferred work.
- [x] Review source, regression tests, generated assets, and bundled plugin runtimes; verify no unintended breaking changes or production Run enablement.
- [x] Decide whether reporting-consumer and affected Kimi-host checks gate publication or only issue closure; document remaining acceptance limits.
- [x] Write release notes and upgrade guidance: flat update preservation/no implicit rename, Kimi reinstall/reload, command enums, explicit targeted-view opt-in, and CI test hardening.
- [x] Audit README/manuals/version pins and packaging docs against the surface-release checklist.
- [x] After version confirmation, bump package.json/package-lock.json to 2.2.0; regenerate/stamp plugin manifests and verify version consistency.
- [x] Run npm run release:check on the final candidate; inspect the actual tarball and smoke both bundled MCP servers, project-root resolution, flat preservation, and targeted registrations.
- [x] Present candidate evidence and obtain explicit approval before committing, pushing, tagging, or publishing.
- [x] After approval, commit coherent changes, push main, wait for GitHub Release Check, tag v2.2.0, and complete the release-environment approval/publish workflow.
- [x] Verify npm 2.2.0/latest, provenance, GitHub Release and installed artifact; update GitHub issues with evidence, close only satisfied acceptance scope, record stable release learning, validate and graduate this initiative.

## Progress Log
- [2026-10-17T04:22:53.049Z] Created initiative via mdocs command
- Release initiative created at user request. Proposed minor 2.2.0 rather than a patch because targeted compiled-view registrations add an opt-in capability. Prior verification is recorded as baseline evidence, not final versioned-candidate approval. No release actions performed.
- User confirmed 2.2.0 minor version. Preparing combined release candidate for the opt-in registration capability and #8–#11 fixes. Commit/push/tag/publish approval remains a separate gate after candidate evidence.
- Prepared docs/release-2.2.0.md and 2.1.0→2.2.0 upgrade notes; updated current README/manual pins. Audited packaging docs against actual workflows and corrected stale pre-publish-only description. Bumped package and lock root versions to 2.2.0 and stamped all three plugin/marketplace manifests. No production Run source changes vs v2.1.0; no dependency or package export changes. Reporting-consumer/Kimi-host confirmation remains explicitly documented as issue-closure follow-up pending release approval.
- Versioned 2.2.0 release:check PASSED: 77 suites/1659 tests, coverage thresholds, typecheck, generated assets, versions, mdocs clean and pack dry-run. Actual tarball smoke PASSED: all metadata/manifests/CLI and bundled Claude/Kimi MCP report 2.2.0; correct project, 13 tools, canonical enum, flat CRLF preservation/stable filename, invalid command/no mutation, external default skip and targeted registration/idempotency. Candidate contains 620 files and release notes. Awaiting explicit approval for commit/push/tag/publish and acceptance-policy confirmation; no external release actions taken.
- User approved the presented 2.2.0 candidate for commit, push, tag and publication. Accepted documented consumer/Kimi-host confirmation as issue-closure follow-ups. Verified remote main has not moved and v2.2.0 tag is absent; release environment has no additional approval rules. Preparing source commit followed by source-fingerprinted plugin bundle commit.
- Approved release pushed: 089815f (source/docs/version), 85a8464 (plugin bundles rebuilt from source 089815f). Verified both checked-in MCP bundles carry 089815f and reran focused MCP checks (9 suites/66 tests). Main push succeeded; waiting for GitHub Release Check before tagging.
- Release Check passed on 85a8464: https://github.com/bbaaxx/harness-mdocs/actions/runs/39004256519 (first attempt). Created and pushed annotated v2.2.0 at 85a8464e0811d4eb7059edbd0bb5574a08d38b62. Publish run queued: https://github.com/bbaaxx/harness-mdocs/actions/runs/39004522383. No publication success claimed yet.
- Publication VERIFIED: npm harness-mdocs@2.2.0 is latest (published 2026-10-17T05:05:39.698Z); GitHub Release v2.2.0 exists and authored notes verified. Release Check and Publish succeeded first attempts. Fresh registry install: npm audit signatures passed 96 signatures/12 attestations; tarball SHA-1/SHA-512 matches metadata, SHA256 b2b440346e2550ffc8c0a146b3d420e4a3ece41de76429fddac4901d490e7df6, 620 files. CLI/Claude/Kimi MCP fingerprint 2.2.0/85a8464 and mutation/registration/project-root smoke checks passed. Posted verification comments to issues #8–#11 without closing any. Stable release wiki recorded. Preparing mdocs-only closure commit; tag stays at 85a8464.
- [2026-10-17T05:09:09.125Z] Marked done via mdocs command

## Artifacts
- docs/release-2.2.0.md — authored release notes and upgrade/acceptance caveats
- docs/issue-8-acceptance.md — scoped acceptance coverage and remaining consumer confirmation
- mdocs/wiki/release/harness-mdocs-2-2-0.md — stable publication evidence and release-process learnings
- /private/var/folders/6p/bhp33vz103gcx_v02y26ch3m0000gn/T/opencode/mdocs-2.2.0-candidate-sTsDDw/harness-mdocs-2.2.0.tgz
- Local candidate SHA-256: 5faf8136bccdc5a464c72c5ab371ddea314843f8fea4df2e663aa17b9d6ac365 (before release-commit fingerprint rebuild)
- Published release: https://github.com/bbaaxx/harness-mdocs/releases/tag/v2.2.0
- Release Check: https://github.com/bbaaxx/harness-mdocs/actions/runs/39004256519
- Publish: https://github.com/bbaaxx/harness-mdocs/actions/runs/39004522383
- Registry artifact: https://registry.npmjs.org/harness-mdocs/-/harness-mdocs-2.2.0.tgz
- Published SHA-256: b2b440346e2550ffc8c0a146b3d420e4a3ece41de76429fddac4901d490e7df6
- Provenance: https://registry.npmjs.org/-/npm/v1/attestations/harness-mdocs@2.2.0
- Registry install/smoke evidence: /private/var/folders/6p/bhp33vz103gcx_v02y26ch3m0000gn/T/opencode/mdocs-published-2.2.0-CKS0vv/published-verification.json
