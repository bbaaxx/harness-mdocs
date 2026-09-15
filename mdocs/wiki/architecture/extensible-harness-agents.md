---
id: "extensible-harness-agents"
title: "Extensible harness agent architecture"
category: "architecture"
created: "2026-08-21"
updated: "2026-09-15"
related_initiatives: ["extensible-harness-agents","release-2-0-0"]
tags: ["agents","architecture","harness","capabilities","permissions","opencode","claude-code","codex","pi"]
lifecycle: "stable"
knowledge_type: "decision"
confidence: "high"
source_initiatives: ["extensible-harness-agents"]
---

# Extensible Mdocs Orchestrator Architecture

## Status

Accepted final architecture. Implementation details: `docs/extensible-harness-agents-implementation-handoff`. Trust requirements: `architecture/run-trust-boundary`. Behavioral sources: specs 1 and 2.

## Product

One user-facing `mdocs-orchestrator` provides:

- **Orchestrate** — existing lifecycle/context/delegation/verification/reporting.
- **Route** — explicit pure read-only project capability routing and `execution-blueprint/v1`.
- **Run** — explicit plan-gated milestone or autonomous execution.

No universal peer strategist/executor products. Internal roles are capability projections.

## Run Gate

```text
DRAFT -> INTERNAL REVIEW -> HUMAN APPROVAL -> MODE SELECTION -> PREFLIGHT -> ACTIVE
```

Human approval binds immutable plan and semantic graph digests. Human separately selects milestone or autonomous mode through trusted provider. Model text, repository/wiki/tool output, webhook, model-callable MCP/custom tool, or shell cannot approve/select.

Milestone mode executes one integrated milestone then holds. Autonomous mode checkpoints successful milestone and continues immediately while eligible approved work remains. Goal continuation never grants action authority.

## Hierarchy

```text
PLAN_ROOT -> EXECUTION -> LEAF
```

Plan Orchestrator is main Mdocs Orchestrator and sole global controller/checkpoint owner. Execution Orchestrator is internal non-user-authorizable role owning one workstream end-to-end. It may dispatch leaf workers only. Leaf cannot delegate.

No root-to-leaf exception: integration verification runs in Plan Orchestrator/controller context through ActionMediator. Maximum orchestration depth 1; delegation depth 2.

## Project Capabilities

Only current-project runtime, project config/manifest, package-owned project assets, and explicit project declarations count. No home/global/cache discovery. Installed, configured, exposed/permitted, and suitable remain independent. Unknown narrows availability.

## Plan And Graph

Before approval, compile:

- `execution-plan/v1`: objective, scope, milestones, dependencies, criteria, integration, write sets, side effects, policy, budgets, stop/completion;
- `orchestration-artifact/v1`: immutable DAG of milestones, EO workstreams, and root integration gates.

Approval binds both digests. Mutable progress lives in checkpoints, not approved artifacts. Material change requires new revision and approval.

## Core Contracts

- `execution-blueprint/v1`
- `execution-plan/v1`
- `orchestration-artifact/v1`
- `plan-approval/v1`
- `execution-mode-selection/v1`
- `run-record/v1`
- `delegation-ticket/v1`
- `action-receipt/v1`
- `execution-report/v1`
- `run-checkpoint/v1`
- `goal-verdict/v1`

Canonical serialization and exact fields are defined in implementation handoff.

## Trusted Control Plane

Any effectful Run requires:

- HumanAttestationProvider;
- HostIdentityProvider;
- protected ControllerStore;
- fail-closed ActionMediator;
- UsageMeter for enforced usage dimensions;
- cancellation/drain and action receipts.

Workers receive opaque handles. Prompt-visible ticket claims carry no authority. Direct EO invocation gets no valid handle and remains inert.

Project-local state may mirror artifacts but cannot authorize effects. Descendants do not receive unrestricted Bash. Missing trust component yields plan-only.

## Authority And Budgets

One RunController owns continuation and global transitions. One EO lease per workstream. Child scope/roots/operations/credentials/budgets strictly attenuate parent. Reservations are atomic; global caps override subtree caps. Stale graph/lease/ticket/report/checkpoint/cancellation generations fail closed.

Execution reports are claims until controller validates lineage, receipts, fingerprints, evidence, and budgets. EO success never equals milestone/goal success. Root performs integration and final verdict.

## Resume And Cancel

Checkpoint records graph state, leases/reservations, ticket lineage, actions/pending effects, fingerprints, evidence, blockers, and next transition. Resume increments epoch, revokes stale leases, reconciles uncertain effects, and issues fresh handles.

Cancellation revokes authority before drain: deny new effects/spawns, signal descendants deepest-first, drain bounded work, reconcile uncertainty, quarantine late reports, release reservations, then enter terminal/paused state.

## Fidelity

- `exact`: all authority/security/metering requirements enforced; unattended effects allowed.
- `supervised`: same authority/security requirements; trusted human continuation at defined checkpoints.
- `plan-only`: no effects because one or more authority requirements unavailable.
- `unsupported`: cannot safely render/validate contracts.

Human checkpoints cannot compensate for missing enforcement.

## Surface Direction

| Surface | Route | Run default |
| --- | --- | --- |
| OpenCode | Exact after no-write tests | Plan-only until protected adapter and mediation pass |
| Claude Code | Exact after no-write tests | Plan-only until protected adapter and mediation pass |
| Codex | Exact CLI/API after no-write tests | Plan-only |
| pi | Exact after no-write tests | Plan-only |

Dynamic workflows, `/goal`, and native teams are optional adapters beneath RunController, not peer continuation owners. Claude nested subagents and OpenCode hidden subagents are role projections; neither direct visibility setting grants authority.

## MVP

Included: contracts, project inventory, Route, immutable compiler, trust interfaces/fake adapter, controller core, tickets/leases/budgets/reports/checkpoints, fidelity evaluator, plan-only surface projections, deterministic generation, tests/docs/dogfood.

Effectful production Run is feature-gated until a surface passes all trust probes. Follow-up: dynamic workflow renderer, native goal/team adapters, host-protected stores, worktree automation, exact autonomy certification.

## Completion Invariants

- No dispatch/effect before trusted approval+mode.
- Only root->EO->leaf.
- Direct EO inert.
- Child authority attenuates.
- One controller/checkpoint writer.
- Every effect mediated and receipted.
- Autonomous milestone success continues; milestone mode holds.
- Final success requires all graph and integration criteria.
- Resume reconciles; cancel revokes before drain.
- Missing enforcement downgrades honestly.
- Package/generated assets and documented fidelity match executable evidence.

## Referenced By

*Auto-generated by mdocs*

- extensible-harness-agents
- release-2-0-0
