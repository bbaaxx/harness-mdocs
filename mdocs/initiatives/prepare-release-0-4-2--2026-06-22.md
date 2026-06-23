---
id: "prepare-release-0-4-2"
title: "Prepare release 0.4.2"
status: "done"
created: "2026-06-22"
updated: "2026-06-23"
owner: ""
tags: ["release","0.4.2","claude-code"]
related_wiki: []
priority: "medium"
next_action: "Mark done"
---

## Objective
Cut 0.4.2 to ship the claude-code workflow-driver + bash-gate fix (initiative workflow-state-machine-has-no-driver) and the manual-install template fix (initiative fix-claude-code-install-template-and-cli-help) that landed on main via PRs #1 and #2. Bump version, pass npm run release:check, hand off the tag+push that triggers publish.yml (npm publish + GitHub Release).

## Plan
- [ ] Bump all 0.4.1 version refs to 0.4.2 (package.json + plugin/marketplace manifests)
- [ ] Run npm run release:check (build + lint + test + coverage + mdocs validate + pack:check)
- [ ] Prepare release commit chore(release): prepare 0.4.2
- [ ] Hand off tag v0.4.2 + push (triggers publish.yml: npm publish + GitHub Release)
- [ ] Record release wiki entry once published

## Progress Log
- [2026-06-22T21:43:25.323Z] Created initiative via mdocs command
- [2026-06-22T21:44:08.206Z] bash executed at step PLAN
- [2026-06-22T21:44:25.701Z] edit executed at step PLAN
- [2026-06-22T21:44:26.492Z] edit executed at step PLAN
- [2026-06-22T21:44:26.652Z] edit executed at step PLAN
- [2026-06-22T21:45:09.436Z] bash executed at step VERIFY
- [2026-06-22T21:45:42.363Z] bash executed at step VERIFY
- Bumped 0.4.1 to 0.4.2: package.json, package-lock.json (root, via npm install --package-lock-only), .claude-plugin/marketplace.json, src/surfaces/claude-code/plugin/.claude-plugin/plugin.json. Codex plugin.json left at 0.1.1 (separately versioned). npm run release:check EXIT=0 (build + lint + 293 tests + coverage + mdocs validate + pack:check). Tarball harness-mdocs-0.4.2.tgz builds at 111.2 kB. Ready for release commit + tag v0.4.2 + push (triggers publish.yml). Handed off commit/tag/push to user (direct main commit is the repo release convention; publish is irreversible).
- [2026-06-23T00:10:15.499Z] bash executed at step COMPLETE
- [2026-06-23T00:10:28.775Z] bash executed at step COMPLETE
- [2026-06-23T00:11:17.235Z] bash executed at step COMPLETE
- [2026-06-23T00:12:11.615Z] bash executed at step COMPLETE
- [2026-06-23T00:13:20.005Z] bash executed at step COMPLETE
- [2026-06-23T00:14:07.785Z] bash executed at step COMPLETE
- PUBLISHED. publish.yml run 27993085405 completed success. npm harness-mdocs@0.4.2 live. GitHub Release v0.4.2 (not draft/prerelease). Release commit 35cc733 on main, tag v0.4.2 pushed. Wiki release/harness-mdocs-0-4-2 recorded.
- [2026-06-23T00:19:00.557Z] Marked done via mdocs command

## Artifacts
