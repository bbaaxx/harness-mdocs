---
id: "run-controller-runtime"
title: "Protected RunController core and fake host driver"
category: "architecture"
created: "2026-09-15"
updated: "2026-09-15"
related_initiatives: ["extensible-harness-agents","release-2-0-0"]
tags: ["agents","run","controller","outbox","recovery","idempotency","cancellation","security"]
---

# Protected RunController core and fake host driver

## Status

WP-230 implements an internal first-profile RunController. Production Run surfaces remain plan-only until concrete host adapters pass protected fidelity probes. Controller modules are intentionally absent from `src/agents/run/index.ts` and public package barrels.

## First profile

- Exactly one milestone.
- Exactly one `EXECUTION` node.
- No `LEAF` nodes.
- Dedicated milestone-integration `PLAN_ROOT` and global-integration `PLAN_ROOT` nodes.
- Fixed typed policy; free-form plan policy is inert.
- Existing public states remain `preparing`, `awaiting-approval`, `running`, `paused`, `cancelling`, `completed`, `failed`, and `cancelled`.

## Pure protected core

`src/agents/run/controller/` contains closed event/command algebra, strict bounded aggregate schema, deterministic reducer, protected CAS repository, immutable safe projection, and imperative driver. Reducer performs no I/O, clock reads, provider calls, or ambient randomness.

Every external operation starts as one durable outbox command. Command identity binds project/run, controller epoch, graph epoch, lease fence, cancellation generation, node, attempt, payload digest, and exact stage inputs. Aggregate validation reconstructs command IDs, completion events, audit chain, model digest, phase invariants, and terminal drain requirements.

Normal journal growth stops before reserved event and byte capacity needed for finite fail-closed cancellation. Terminal states require no live controller/workstream authority, unresolved effects, pending usage/projections, descendants, recovery targets, or outbox entries.

## Driver and host boundary

`driver.step()` processes at most one command. `runUntilBlocked(maxSteps)` is explicitly bounded. Driver materializes strict per-kind host requests only from validated protected aggregate/model bindings; no prompt prose, environment variables, repository text, credentials, handles, or raw authority objects enter model-visible results.

Host operations are bounded with `AbortSignal` and timeout. Every command is reconciled before execution. `unsupported` and `still-uncertain` fail closed; execution starts only after exact command-bound quiescence proof. `executeOnce` requires durable atomic deduplication by command ID. Driver also provides host-object single-flight, but production adapters remain responsible for cross-process durable deduplication.

Known host failure becomes a typed failed completion. Timeout, transport ambiguity, lost acknowledgement, or unknown exception becomes uncertain; driver never infers success from exception text. Applied results pass strict command-kind schemas before reducer events are built.

## Crash and concurrency behavior

Controller repository uses expected-generation CAS. Unknown commit outcome triggers reread and exact event ID/digest reconciliation. A missing event after indeterminate persistence returns recovery-required; effect is not replayed. Concurrent drivers may race on controller CAS, but host `executeOnce` permits only one durable effect claim. CAS losers reread the accepted event.

Recovery events distinguish `applied`, command-bound quiesced `not-applied`, and `still-uncertain`. Retries require proof the prior attempt cannot still execute. Exact report replay consumes an active validator only when same validator kind, report digest, evidence, and material classification match protected history.

## Cancellation

Closure order is authority revocation, descendant signal, bounded force/drain, interrupted-command reconciliation, durable checkpoint, terminal state. Missing descendant counts never mean zero. Timed-out or interrupted effects remain recovery-required until applied or quiesced. Failed and completed terminal intents use the same authority-safe closure path.

## Accounting and receipts

WP-230B settles child reservations before parents, revalidates persisted final usage immediately before provider commit, fences settlement owners/flights, and records EO-inclusive descendant usage. Mediation schema v9 persists independent normalized executor completion evidence and digest. Preliminary and committed receipts reconstruct from protected completion facts; settlement time never replaces effect-time receipt arrival. Root finalization groups stable reservation/authority identity across controller lease turnover while each receipt retains its own lease provenance.

## Verification

Acceptance review result: `No issues.` Full release gate passed 64 suites / 1,539 tests, coverage, typecheck/lint, build, generated assets, mdocs validation, package dry-run, and `git diff --check`.

## Referenced By

*Auto-generated by mdocs*

- extensible-harness-agents
- release-2-0-0
