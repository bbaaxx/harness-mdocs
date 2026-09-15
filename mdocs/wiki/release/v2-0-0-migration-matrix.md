---
id: "v2-0-0-migration-matrix"
title: "v2.0.0 Breaking-Change & Migration Matrix (v0.8.1 → HEAD fbd5181)"
category: "release"
created: "2026-09-15"
updated: "2026-09-15"
related_initiatives: []
tags: ["release","2.0.0","migration","breaking-changes"]
---

# v2.0.0 Breaking-Change & Migration Matrix

Source: `git diff v0.8.1..HEAD` (HEAD = fbd5181). Verified 2026-09-15 via packed-tgz dogfood.

## Verdict: zero breaking changes. Release is purely additive.

Full-repo diff: 170 files, **+67,088 / -13**. All 13 deletions are mdocs bookkeeping and one package.json script line. **Zero deletions in `src/`.**

## Surface-by-surface

| Area | Changed? | Detail | Migration needed |
|---|---|---|---|
| `src/core` (workflow engine, operations) | No | byte-identical | none |
| `src/cli` | No | byte-identical | none |
| `src/surfaces` (claude-code, codex, opencode, pi) | No | byte-identical | none |
| `src/wiki`, `src/initiatives` | No | byte-identical | none |
| package deps | No | `@modelcontextprotocol/sdk ^1.0.0`, `zod ^4.1.8` unchanged | none |
| `mdocs/` data format | No | legacy v0.8.1-shaped dir validates clean under HEAD build; resume + search verified in dogfood Act 3 | none |
| MCP tool surface | No | 13 tools at both tags (`mdocs_reset`/`mdocs_advance` already in v0.8.1 engine + operations) | none |

## Additions (new, opt-in)

| Addition | What | Risk |
|---|---|---|
| `src/agents/` module | capability registry, canonical digests, Route, project read context (WP-000…WP-120) | none to existing consumers; new API surface |
| `src/agents/run/` | protected run controller: trust, authority broker, plan/execution-graph compiler, receipt validation, evidence, fidelity measurement, storage (WP-200…WP-225) | new; controller is additive, no existing call sites rewired |
| `src/generation/` | deterministic asset generator + fragments for all four surfaces; `generate:agents` / `check:agents` scripts; `quality` now includes `check:agents` | contributors must run `npm run generate:agents` when editing fragments — doc note in release notes |
| package export `./agents` | new subpath | none |

## Correction to earlier assumption

`mdocs_reset` / `mdocs_advance` are **not** new in 2.0 — present in v0.8.1 (`src/core/operations.ts`, `engine.ts`). The 11-vs-13 tool discrepancy in the stale-build check was about the *running server*, not the tag diff.

## Release-blocking findings (tracked in initiative fix-pre-release-dogfood-findings-gitsha-cli-create-activation-cli-output-contract)

1. gitSha null in packed build
2. CLI `initiative.create` does not activate initiative (bug unless surface limitation)
3. CLI `step` output contract: plain text on error, JSON on success

## Migration guide for release notes

**Upgrading from 0.8.x: install 2.0.0, nothing else changes.** Existing `.mdocs/` data, CLI commands, MCP tools, and surface integrations are untouched. New `harness-mdocs/agents` export and agent-asset generation are opt-in.