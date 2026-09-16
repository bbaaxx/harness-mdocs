---
id: "agent-manual-2-0-0"
title: "Agent Manual for harness-mdocs 2.0.0"
category: "docs"
created: "2026-09-16"
updated: "2026-09-16"
related_initiatives: ["user-and-agent-manuals-for-harness-mdocs-2-0-0"]
tags: ["docs","manual","2.0.0","agents"]
---

# Agent Manual (docs/agent-manual.md)

Agent-facing operational reference for harness-mdocs 2.0.0, written under initiative `user-and-agent-manuals-for-harness-mdocs-2-0-0`.

## Covers
- Canonical 13-tool surface (parity enforced by tests/surfaces/parity.test.ts)
- `mdocs` command subcommands (registry-verified)
- Workflow contract: steps, gate (Write/Edit blocked pre-PLAN, PLAN..COMPLETE one edits band, Bash audited, ./mdocs/ always editable), IDLE open|readonly
- Lifecycle: advance/reset/resume semantics, create-vs-resume activation
- Subagent dispatch via mdocs_dispatch (bundle: objective, plan, related wiki, top-5 memory, 5 recent audit events)
- Progress/wiki hygiene, bidirectional linking, completion-gate wiki-learning expectation
- Audit trail awareness; per-surface differences table

## Provenance
253 lines. Tool names match CANONICAL_TOOL_NAMES; steps match STEPS in engine.ts; gate rules confirmed in canExecuteTool; MDOCS_* env keys grep-verified.