---
id: "run-trust-boundary"
title: "Run trust boundary and production fidelity"
category: "architecture"
created: "2026-08-24"
updated: "2026-09-15"
related_initiatives: ["extensible-harness-agents","release-2-0-0"]
tags: ["run","security","attestation","mediation","storage","fidelity","agents"]
lifecycle: "stable"
knowledge_type: "decision"
confidence: "high"
source_initiatives: ["extensible-harness-agents"]
---

# Run Trust Boundary And Production Fidelity

## Status

Accepted implementation prerequisite. This decision narrows earlier optimistic supervised projections.

## Core Decision

Any effectful Run—exact or supervised—requires a trusted control plane outside worker authority. Project-local files are inspectable mirrors only and cannot authorize execution. If a surface cannot provide protected authority storage, trusted human attestation, host-bound identity, fail-closed action mediation, cancellation, and required metering, that surface is **plan-only**.

A human checkpoint does not compensate for missing enforcement.

## Trusted Control Plane

Required components:

1. **HumanAttestationProvider** — presents exact plan/graph digests and a nonce through trusted host UI/control channel; records separate approval and mode gestures. Model-callable MCP, custom tools, shell, repository text, webhooks, copied JSON, and prompt claims cannot mint attestation.
2. **HostIdentityProvider** — binds host session/agent/tool-call identity to controller-issued opaque handles. Agent names, prompt role strings, environment variables, and user-supplied metadata are not identity.
3. **ControllerStore** — host-owned atomic CAS store with protected checkpoint, lease, budget, approval, ticket, cancellation, and receipt state. Workers cannot read/write authority records directly.
4. **ActionMediator** — mandatory pre-effect broker. It validates current opaque handle, ticket lineage, generations, policy, approvals, write ownership, budget, and cancellation before executing structured action. It persists intent before effect and receipt afterward.
5. **UsageMeter** — monotonic provider/model/action usage source with confidence and reservation/reconciliation. Unknown authoritative usage cannot satisfy hard token/cost ceilings.

Workers receive opaque handles, never bearer-like authority documents. Every effect path consults control plane. Direct internal-agent invocation receives no valid handle and remains inert.

## Action Mediation

Effectful Run descendants do not receive unrestricted Bash or equivalent shell authority. Allowed execution uses structured, allowlisted argv/actions or a sandbox whose filesystem, network, process, and credential boundaries are enforced independently of prompts.

Required bypass coverage includes:

- shell redirects, pipelines, interpreters, generated scripts, child processes;
- Git and package lifecycle hooks;
- network clients and authenticated MCP tools;
- alternate/custom tool names;
- direct filesystem APIs;
- writes to controller/audit/checkpoint storage;
- agent/team/workflow spawn operations.

Post-execution receipts are evidence, not prevention. Missing pre-effect mediation means plan-only.

## Fidelity Truth Table

| Fidelity | Requirements | Behavior |
| --- | --- | --- |
| `exact` | All trust components enforced; complete action mediation; protected state; identity; authoritative required metering; unattended continuation | Effectful autonomous Run allowed within approved envelope. |
| `supervised` | Same authority, mediation, protected-state, identity, and budget invariants as exact | Effectful Run allowed, but trusted human continuation required at defined checkpoints. |
| `plan-only` | One or more trust invariants unavailable | No effects. Produce plan, graph, approval forecast, route, and diagnostics only. |
| `unsupported` | Cannot even render/validate required contracts safely | Refuse capability. |

Missing authority storage, attestation, identity, action mediation, or required hard-budget metering always yields plan-only—not supervised.

## Topology

Only these delegation edges exist:

```text
PLAN_ROOT -> EXECUTION -> LEAF
```

Plan Orchestrator does not dispatch direct integration leaves. Integration verification executes in controller/Plan Orchestrator context through ActionMediator. This removes prior topology ambiguity.

## Attestation Semantics

Approval and mode selection may come from same human but require separate trusted events.

Each event binds:

- provider ID/version and principal reference;
- run preparation ID and one-time challenge nonce;
- plan and graph digests visibly presented;
- decision, timestamp, expiry, revocation generation;
- host session/project binding;
- signature/MAC or host-verifiable opaque reference.

Plan/graph/policy material change, project change, expiry, revocation, or replay invalidates event.

## Usage Meter Semantics

Meter reports source/provider/model, input/output/cache tokens, price-table version, cost currency/value, action count, confidence, reservation, committed usage, delayed-final state, and timestamp.

Before dispatch, controller reserves worst-case bounded usage. Final receipt reconciles. Unsupported/unknown token or cost telemetry can be omitted only when approved plan does not enforce that dimension; changing hard budgets requires new approved plan revision.

## Production Surface Consequence

Current repository adapters are not yet trusted Run surfaces. MVP may ship:

- exact read-only Route;
- trusted-controller core validated through fake/test adapter;
- plan-only OpenCode, Claude Code, Codex, and pi by default;
- effectful supervised/exact surface only after all probes and adversarial tests pass.

Do not promise effectful supervised Run based only on prompt, hooks that fail open, project-local state, or human-visible pauses.

## Referenced By

*Auto-generated by mdocs*

- extensible-harness-agents
- release-2-0-0
