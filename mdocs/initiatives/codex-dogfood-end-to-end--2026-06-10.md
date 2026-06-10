---
id: "codex-dogfood-end-to-end"
title: "Codex Dogfood End To End"
status: "done"
created: "2026-06-10"
updated: "2026-06-10"
owner: ""
tags: ["codex","dogfood","plugin"]
related_wiki: ["testing/codex-repo-dogfood"]
priority: "medium"
phase: "done"
next_action: "No follow-up required; v1 CLI-backed Codex workflow is usable with the documented fresh-thread requirement."
---

## Objective
Dogfood the harness-mdocs Codex plugin end-to-end using the documented repo install playbook and report whether the v1 CLI-backed workflow is usable in a fresh Codex session.

## Plan
- [x] Run or inspect mdocs_resume for the initiative.
- [x] Read the initiative, wiki, docs, README, and Codex acceptance test.
- [x] Follow the Codex repo install playbook as closely as possible.
- [x] Verify init/status, initiative create/update, wiki create/update, validate, lookup, dispatch/resume.
- [x] Record deviations, missing docs, confusing wording, or bugs.
- [x] Run npm run test:codex, npm run build, and broader tests if changes warrant.
- [x] Update progress, add stable wiki learning, and mark done if fully validated.

## Progress Log
- [2026-06-10T14:32:58.836Z] Created initiative via mdocs command
- [2026-06-10T14:40:00Z] Dogfood setup: mdocs init/status worked via .agents/bin shim; repo marketplace was added; mdocs@harness-mdocs-local installed into Codex plugin cache; installed cache contains manifest and three skills. Current already-running thread did not gain Mdocs via tool_search, matching playbook guidance to restart/open a fresh thread after install.
- [2026-06-10T14:50:00Z] PASS: Dogfooded documented Codex repo install path. Commands run: npm install; npm run build; plugin validator; PATH=$PWD/.agents/bin:$PATH mdocs init/status/command initiative.create/command initiative.update/command wiki.create/command wiki.update/lookup/search/dispatch/resume/validate; codex plugin marketplace list/add; codex plugin list/add; npm run test:codex; npm test -- --runInBand. Results: mdocs CLI workflow usable; repo marketplace discovery/install works; installed cache contains manifest plus mdocs-workflow, mdocs-initiative, and mdocs-orchestrator skills; validation clean; tests/build pass. Deviations/findings: original mdocs memory was initialized but empty, so the requested resume initially returned Initiative not found; this already-running thread did not gain newly installed plugin skills, so a fresh Codex thread is required as documented; codex plugin commands emitted PATH alias warnings under sandboxed execution but still completed. Files changed: added mdocs initiative, wiki, indexes, workflow state, and index metadata.
- [2026-06-10T14:34:53.361Z] Marked done via mdocs command
- [2026-06-10T15:00:00Z] Follow-up fix from dogfood: after marking the initiative done, mdocs validate warned that the done initiative had no stable wiki learning. Root cause: wiki.create accepted lifecycle/provenance metadata, but wiki.update could not update lifecycle, knowledgeType, confidence, sourceInitiatives, or supersedes, preventing CLI-only promotion of a wiki entry to stable. Added failing test, fixed wiki.update metadata handling, rebuilt, and used the CLI to mark testing/codex-repo-dogfood as lifecycle stable.
- [2026-06-10T15:05:00Z] Final verification after code fix: npm run test:codex passed (2 suites, 4 tests); npm run build passed; npm test -- --runInBand passed (20 suites, 185 tests); plugin validator passed; mdocs validate passed with no errors or warnings. Files changed: src/core/commands/registry.ts, tests/core/wiki-command-update.test.ts, and new mdocs memory files under mdocs/.

## Artifacts
- `mdocs/wiki/testing/codex-repo-dogfood.md` - stable dogfood learning.
- `src/core/commands/registry.ts` - fixed `wiki.update` metadata support.
- `tests/core/wiki-command-update.test.ts` - regression coverage for CLI metadata updates.
