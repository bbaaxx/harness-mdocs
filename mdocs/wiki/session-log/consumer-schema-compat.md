---
id: "consumer-schema-compat"
title: "consumer-schema-compat release session"
category: "session-log"
created: "2026-06-24"
updated: "2026-06-24"
related_initiatives: []
tags: ["session-log","consumer-schema","release"]
---

# consumer-schema-compat release session

- [2026-06-24] Landed cc0 (config loader + initiativeRecordMode contract flag + readExpectedDurationRaw + core.contract + MdocsLinter contract param), cc1 (metadata-only initiative writes: store/manager/hooks), cc2 (linter tolerance), cc3 (wiki canonical id/ref + appendLog consumer heading) on branch feat/consumer-schema-compat. Baseline 385 -> 414 tests green, tsc clean.
- [2026-06-24] cc4: documented `.mdocs.json` + initiativeRecordMode in claude-md-snippet, CLAUDE.md, README, docs/consumer-layering.md; recorded this model via wiki.create. Full gate (build/build:claude-plugin/test/coverage/mdocs:validate) next, then PR.

Key integration fix: cc1 metadata-only markDone had to ADD the `completed` lifecycle key (core bookkeeping) while still refusing to inject optional keys like `next_action` — lifecycle keys split into core (add-or-update) vs optional (update-only-if-present).