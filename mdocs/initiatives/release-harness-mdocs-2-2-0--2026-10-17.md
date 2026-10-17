---
id: "release-harness-mdocs-2-2-0"
title: "Release harness-mdocs 2.2.0"
status: "active"
created: "2026-10-17"
updated: "2026-10-17"
owner: ""
tags: ["release","2.2.0","npm","github-actions","bugfix"]
related_wiki: ["release/tag-based-npm-publishing","release/version-stamping","docs/surface-release-docs-checklist","architecture/mutation-and-surface-boundary-hardening","release/harness-mdocs-2-2-0"]
phase: "verification"
next_action: "Commit approved source/docs/version, rebuild and commit plugin runtimes, push main, wait for Release Check, then tag and publish v2.2.0."
priority: "high"
depends_on: ["address-open-issues-8-11"]
handoff_summary: "User explicitly APPROVED committing, pushing, tagging and publishing 2.2.0. Candidate gates passed (77 suites/1659 tests, coverage, packaging and actual 620-file artifact smoke). Remote main still ee041f0; v2.2.0 does not exist. Release environment has no protection rules. Commit source/docs/version first, rebuild plugin runtimes from that source SHA, commit bundles, push main and wait Release Check before tag. Keep reporting-consumer/Kimi-host acceptance as documented issue-closure follow-ups; do not infer live confirmation from automated smoke."
open_questions: []
blockers: []
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
- [ ] After approval, commit coherent changes, push main, wait for GitHub Release Check, tag v2.2.0, and complete the release-environment approval/publish workflow.
- [ ] Verify npm 2.2.0/latest, provenance, GitHub Release and installed artifact; update GitHub issues with evidence, close only satisfied acceptance scope, record stable release learning, validate and graduate this initiative.

## Progress Log
- [2026-10-17T04:22:53.049Z] Created initiative via mdocs command
- Release initiative created at user request. Proposed minor 2.2.0 rather than a patch because targeted compiled-view registrations add an opt-in capability. Prior verification is recorded as baseline evidence, not final versioned-candidate approval. No release actions performed.
- User confirmed 2.2.0 minor version. Preparing combined release candidate for the opt-in registration capability and #8–#11 fixes. Commit/push/tag/publish approval remains a separate gate after candidate evidence.
- Prepared docs/release-2.2.0.md and 2.1.0→2.2.0 upgrade notes; updated current README/manual pins. Audited packaging docs against actual workflows and corrected stale pre-publish-only description. Bumped package and lock root versions to 2.2.0 and stamped all three plugin/marketplace manifests. No production Run source changes vs v2.1.0; no dependency or package export changes. Reporting-consumer/Kimi-host confirmation remains explicitly documented as issue-closure follow-up pending release approval.
- Versioned 2.2.0 release:check PASSED: 77 suites/1659 tests, coverage thresholds, typecheck, generated assets, versions, mdocs clean and pack dry-run. Actual tarball smoke PASSED: all metadata/manifests/CLI and bundled Claude/Kimi MCP report 2.2.0; correct project, 13 tools, canonical enum, flat CRLF preservation/stable filename, invalid command/no mutation, external default skip and targeted registration/idempotency. Candidate contains 620 files and release notes. Awaiting explicit approval for commit/push/tag/publish and acceptance-policy confirmation; no external release actions taken.
- User approved the presented 2.2.0 candidate for commit, push, tag and publication. Accepted documented consumer/Kimi-host confirmation as issue-closure follow-ups. Verified remote main has not moved and v2.2.0 tag is absent; release environment has no additional approval rules. Preparing source commit followed by source-fingerprinted plugin bundle commit.

## Artifacts
- docs/release-2.2.0.md — authored release notes and upgrade/acceptance caveats
- docs/issue-8-acceptance.md — scoped acceptance coverage and remaining consumer confirmation
- mdocs/wiki/release/harness-mdocs-2-2-0.md — candidate evidence (draft; not a publication claim)
- /private/var/folders/6p/bhp33vz103gcx_v02y26ch3m0000gn/T/opencode/mdocs-2.2.0-candidate-sTsDDw/harness-mdocs-2.2.0.tgz
- SHA-256: 5faf8136bccdc5a464c72c5ab371ddea314843f8fea4df2e663aa17b9d6ac365
