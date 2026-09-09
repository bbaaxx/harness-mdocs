---
id: "extensible-harness-agents-implementation-handoff"
title: "Extensible Mdocs Orchestrator implementation handoff"
category: "docs"
created: "2026-08-24"
updated: "2026-08-24"
related_initiatives: ["extensible-harness-agents"]
tags: ["agents","implementation-plan","handoff","route","run","orchestrator","teams"]
lifecycle: "stable"
knowledge_type: "guide"
confidence: "high"
source_initiatives: ["extensible-harness-agents"]
---

# Extensible Mdocs Orchestrator Implementation Handoff

## Status

**READY for implementation-team takeover.** WP-000 baseline adoption may start immediately after baseline verification. Parallel feature work starts only after WP-000, WP-090, and WP-100 land.

No production surface is assumed capable of effectful Run. Missing trust components forces plan-only.

## Authoritative Reading Order

1. `architecture/extensible-harness-agents`
2. `architecture/run-trust-boundary`
3. `architecture/plan-gated-autonomous-run-spec-1`
4. `architecture/hierarchical-run-orchestration-spec-2`
5. This handoff
6. Initiative `extensible-harness-agents`

If older prose conflicts with `run-trust-boundary` or this handoff, newer trust decision wins.

## Target Product

One user-facing `mdocs-orchestrator` exposes:

- default **Orchestrate**;
- explicit, side-effect-free **Route** producing `execution-blueprint/v1` from project evidence only;
- explicit **Run** requiring immutable human-approved plan+graph and separate trusted milestone/autonomous selection;
- internal non-user-authorizable Execution Orchestrators owning bounded workstreams;
- leaf workers with no delegation;
- measured per-surface fidelity.

Only topology: `PLAN_ROOT -> EXECUTION -> LEAF`. Plan/root performs integration itself through ActionMediator; no root-to-leaf exception. Orchestration depth <=1, delegation depth <=2.

## Existing Uncommitted Baseline

Adopt, review, then commit as part of WP-000; do not recreate:

- `src/agents/{schema,definitions,registry,evidence,index}.ts`
- `tests/agents/capabilities.test.ts`
- `package.json` `./agents` export
- `tests/surfaces/opencode/package-assets.test.ts` export checks

Baseline before uncommitted work: `6b21f5b`.

Recorded prior verification: 529 tests/46 suites plus typecheck, build, lint, coverage, pack dry-run. Fresh planning check: 26 capability tests and typecheck pass. Re-run required before adoption.

Untracked `mdocs/audit.log.1` and `.2` are runtime artifacts; exclude unless intentionally reviewed and required.

## Locked Decisions

| Area | Decision |
| --- | --- |
| Product identity | Only `mdocs-orchestrator` user-facing. |
| Roles | `PLAN_ROOT -> EXECUTION -> LEAF`; no root-to-leaf or recursive EO edge. |
| Approval | Trusted human event binds exact plan+graph digests. |
| Mode | Separate trusted milestone/autonomous event; same person allowed, separate gesture required. |
| Route | Uses side-effect-free context; no audit/workflow/lifecycle writers. |
| Run authority | Trusted control plane outside worker authority. Project files are mirrors only. |
| Effects | All through fail-closed ActionMediator; unrestricted descendant Bash forbidden. |
| Controller | One global continuation lease and checkpoint writer. |
| Autonomous behavior | Successful milestones continue immediately while eligible approved work remains. |
| Isolation | Overlapping write sets serialize; automatic worktrees follow-up. |
| Dynamic workflows/teams | Follow-up adapters beneath controller, never peer loop authority. |
| Missing enforcement | Plan-only, not supervised. |
| User assets | Never overwrite. Collision emits diagnostic and lowers fidelity. |
| Feature rollout | Run default off until adapter passes trust probes; Route may ship independently. |

## Fidelity Truth Table

| Fidelity | Required invariants | Effects |
| --- | --- | --- |
| `exact` | Trusted attestation, identity, protected store, complete mediation, cancellation, required authoritative metering | Autonomous effects allowed. |
| `supervised` | Same authority/security invariants as exact | Effects allowed with trusted human continuation checkpoints. |
| `plan-only` | Any authority/security invariant missing | No effects. |
| `unsupported` | Contract rendering/validation itself unavailable | Refuse. |

Human-visible pause never compensates for missing enforcement.

## Conservative Defaults

Approved plan may lower. Raising requires new approved revision.

| Budget | Default |
| --- | ---: |
| Active EOs / leaves per EO / global descendants | 2 / 2 / 6 |
| Cumulative descendant spawns | 12 |
| Retry per node / global retries / local fix loops | 1 / 4 / 2 |
| Run / EO / leaf wall time | 60m / 20m / 10m |
| Global / EO / leaf tool actions | 120 / 40 / 20 |
| Global / EO / leaf tokens | 200k / 60k / 25k |
| Global / EO cost | USD 5 / USD 2 |
| Network/external mutations | 0 unless approved |
| Credential grants | None |
| EO lease TTL / heartbeat | 60s / 15s |
| Cancellation drain | 30s |
| Checkpoint | Every transition/effect; max 30s |
| Write conflict | Serialize unless isolation proven |

Token/cost ceilings are enforceable only with authoritative UsageMeter. If unavailable, approved plan must omit those hard dimensions or surface stays plan-only.

## Canonical Serialization And Digests

Use RFC 8785 JSON Canonicalization Scheme over UTF-8.

Envelope:

```json
{
  "kind": "execution-plan/v1",
  "schemaVersion": 1,
  "id": "...",
  "payload": {},
  "digest": "sha256:<64 lowercase hex>"
}
```

Digest preimage:

```text
UTF8(kind) || 0x00 || RFC8785({schemaVersion,id,payload})
```

`digest` is excluded. Reject non-I-JSON numbers, NaN, Infinity, negative zero, duplicate object keys, invalid Unicode, and unsupported numeric precision before canonicalization. Runtime IDs use UUIDv7; stable plan/milestone/node keys use lowercase kebab identifiers. Timestamps use RFC3339 UTC with `Z`. Digests are domain-separated by `kind`.

A material change is any payload change affecting objective, scope, milestones, graph, criteria, verification, write sets, side effects, policy, budgets, adapter requirements, or completion/pause rules. Display-only labels may be explicitly excluded only by schema.

## Contract Field Catalog

All schemas strict; TypeScript types inferred from Zod. Unknown schema major fails closed.

### `execution-blueprint/v1`

Fields: request digest; project identity/root; inventory digest; capability observations; selected/rejected routes with reasons; topology; fidelity requirements/result; side effects; approval forecast; verification; fallbacks; unresolved preflight checks.

Invariant: generated through pure Route; no authority or mode selection.

### `execution-plan/v1`

Fields: objective; scope/out-of-scope; milestones with stable IDs/dependencies/criteria/verification; integration/regression criteria; write sets; expected side effects; policy; budgets; pause/failure/cancel/completion rules.

Invariant: no mutable progress.

### `orchestration-artifact/v1`

Fields: plan digest; nodes (`milestone|workstream|integration`); legal role owner; edges; write sets/isolation; local/global criteria; fanout/budgets; adapter requirements; expected report kind.

Invariants: acyclic; no dangling edges; workstreams milestone-bounded; integration owner `PLAN_ROOT`; legal delegation edge only root->EO->leaf.

### `plan-approval/v1`

Fields: plan+graph digests/revision; HumanAttestationProvider ID/version; principal reference; challenge nonce/reference; host project/session; decision; issued/expires/revoked generation; opaque verification reference.

### `execution-mode-selection/v1`

Same binding fields plus `milestone|autonomous`. Must be separate event from approval. No default.

### `run-record/v1`

Fields: run ID; project ID; approved digests; approval/mode refs; controller identity/lease; policy/capability/adapter snapshots; state; graph epoch; cancellation generation; created/updated.

### `delegation-ticket/v1`

Fields: opaque handle ID; run/graph/node/parent/generation; issuer/recipient semantic role; host-bound identity ref; scope/write set/criteria; operation/tool/credential classes; approval refs; budgets; allowed child role/depth/fanout; nonce/replay/expiry/cancellation; report destination/schema.

Ticket body stays control-plane-only; model receives opaque handle.

### `action-receipt/v1`

Fields: action/idempotency IDs; handle lineage; normalized operation digest; intent timestamp; start/end; result class; allowlisted redacted input/result metadata; before/after workspace fingerprints; usage reservation/final; uncertainty status; artifact hashes.

### `execution-report/v1`

Fields: ticket/lease lineage; child lineage; mutations/actions; criterion results; receipt/evidence refs; budget reconciliation; assumptions; unresolved/uncertain outcomes; requested disposition.

Report is claim until controller validates.

### `run-checkpoint/v1`

Fields: CAS generation; graph epoch; cancellation generation; node states; controller/workstream leases; reservations/usage; ticket refs; completed action IDs; pending effects; fingerprints; evidence/report refs; blockers; next transition; checksum.

### `goal-verdict/v1`

Fields: accepted nodes; integration/regression evidence; independent review; unresolved/uncertain items; budget totals; final state/reason; completion timestamp.

## Trust Interfaces

### `HumanAttestationProvider`

Must display exact plan/graph digests and one-time nonce in trusted host UI/control channel; record separate approval and mode gestures; bind principal/project/session; support expiry/revocation/replay checks.

Negative oracle: repository/wiki/model/tool output, webhook, model-callable MCP/custom tool, shell/CLI launched by model, copied JSON, or forged host metadata cannot mint attestation.

### `HostIdentityProvider`

Maps trusted host session/agent/tool-call identity to opaque ticket handle. Agent names, prompts, env vars, or caller-supplied metadata are insufficient.

### `ControllerStore`

Host-owned protected CAS store. Workers cannot access authority records through filesystem, Bash, MCP, custom tools, or child process. Project-local artifacts are non-authoritative mirrors.

### `ActionMediator`

Persists intent, validates current handle/ticket/generations/policy/approval/write set/budget/cancellation, executes structured action through broker/sandbox, then persists receipt. Every spawn and effect path uses it.

### `UsageMeter`

Reports source/provider/model, input/output/cache units, price-table version, cost, confidence, reservation, final reconciliation, delay/finality. Hard budget dispatch requires bounded reservation and tolerated overshoot rule; default tolerated overshoot is zero beyond reserved maximum.

## Revised Work Packages

### WP-000 — Baseline adoption and drift inventory

Owner: integrator. Verify/build first slice; snapshot generated/source paths; correct declaration/version/test-fixture drift only where needed to establish baseline. Do not build feature generator yet.

Gate: `npm run build`; capability/package tests; typecheck; full tests; coverage; pack dry-run; clean diff check. Exclude audit rotations.

### WP-090 — Trust foundation decisions and interfaces

Depends: WP-000. Owner: security/runtime architect.

Define HumanAttestationProvider, HostIdentityProvider, ControllerStore protection contract, ActionMediator boundary, UsageMeter, fidelity truth table, opaque handle semantics, rollout kill switch, and trusted fake adapter.

Gate: negative forged-origin/identity fixtures; missing component deterministically yields plan-only.

### WP-100 — Contract retrofit

Depends: WP-090. Owner: schema engineer.

Implement field catalog above, semantic roles, internal EO profile, strict topology, canonicalization/digests, compatibility policy, valid/invalid fixtures.

Gate: strict schemas; digest golden vectors; no root->leaf; changed material digest invalidates approval; approval/mode separate.

### WP-105 — Generator foundation

Depends: WP-100. Owner: build engineer.

Define canonical prompt fragments, source-to-output manifest, deterministic generator/check mode, stale-output deletion, provenance digest. Surface teams must not hand-edit generated mirrors after this lands.

### WP-110 — Plan and graph compiler

Depends: WP-100. Owner: compiler engineer.

Canonical normalization, deterministic DAG, graph validation, approval binding.

### WP-115 — Side-effect-free project context

Depends: WP-000. Owner: core/Route engineer.

Create read-only project context that constructs no AuditLog/workflow/lifecycle writer. Route calls bypass project-local post-tool progress/audit writes. Define package/workspace symlink policy and containment at read time.

Gate: fresh absent `mdocs/`, read-only filesystem, write-spy, and before/after tree tests show zero mutation.

### WP-120 — Project inventory and Route

Depends: WP-100, WP-115. Owner: Route engineer.

Project runtime/config/manifest/package evidence only; deterministic eligibility/selection/blueprint. Unknown never upgrades; global-only unavailable.

### WP-200 — Protected controller storage

Depends: WP-090, WP-100. Owner: persistence engineer.

Implement interfaces, fake trusted adapter, atomic CAS/checksum/generation/fencing/recovery. Project-local mirror cannot enable effects.

### WP-210 — Tickets, leases, budgets

Depends: WP-100, WP-200. Owner: authority engineer.

Opaque handle broker, attenuation, leases, atomic reservations, replay/expiry/cancellation.

### WP-220 — Receipt/report pure validation

Depends: WP-100, WP-200, WP-210. Owner: evidence engineer.

Redaction, fingerprints, receipt/report schemas and pure validation/quarantine. State integration belongs WP-230.

### WP-225 — ActionMediator

Depends: WP-090, WP-200, WP-210, WP-220, WP-300. Owner: mediation/security engineer.

Mandatory pre-effect broker and structured executor. Cover shell redirect/interpreter/child-process/Git/package hook/network/MCP/custom-tool/filesystem/spawn bypasses. Missing mediation plan-only.

### WP-300 — Surface fidelity evaluator

Depends: WP-090, WP-100. Owner: cross-surface architect.

Measured probes for attestation, identity, protected store, action mediation, receipts, depth, cancellation, metering. Route and Run separate. Every downgrade reasoned.

### WP-230 — RunController

Depends: WP-110, WP-120, WP-200, WP-210, WP-220, WP-225, WP-300. Owner: senior runtime engineer.

Pure transitions/effects, scheduling, report acceptance, integration, milestone/autonomous continuation, recovery, cancellation, verdict.

### WP-310 / WP-320 — OpenCode / Claude projections

Depends: WP-105, WP-120, WP-230, WP-300. Surface owners also own protected adapter and ActionMediator integration for their surface. Claude owner includes `src/cli/hooks/**`, templates, manifests, and source assets. No production effects until all probes pass.

### WP-330 / WP-340 — Codex / pi plan-only projections

Depends: WP-105, WP-110, WP-120, WP-300. May start before WP-230. Codex owner includes CLI Route integration with integrator-reviewed root CLI changes. pi remains plan-only unless future trust adapter passes.

### WP-350 — Final generation/package integration

Depends: all surface packages. Owner: build/release engineer.

Regenerate, byte-compare, delete stale outputs, verify runtime imports/tarball/provenance/collisions.

### WP-400 — Integration and documentation

Depends: WP-350 and core fake trusted adapter. Owner: QA/docs.

Test autonomous/milestone traces on fake trusted adapter; actual surfaces follow measured fidelity. Docs describe implementation, never aspiration.

### WP-405 — Rollback rehearsal

Depends: WP-350, WP-400. Owner: release/reliability.

Disable Run kill switch; revoke/cancel/drain; preserve/export checkpoint; install previous package; prove Orchestrate compatibility; verify old binary cannot mutate newer Run-state schema.

### WP-410 — Final gate

Depends: WP-405. Independent security/reliability review plus release checks.

## Dependency Waves

```text
Wave 0: WP-000
Wave 1: WP-090
Wave 2: WP-100 and WP-115
Wave 3 parallel: WP-105, WP-110, WP-120, WP-200, WP-300
Wave 4: WP-210
Wave 5: WP-220; Codex/pi plan-only may begin
Wave 6: WP-225
Wave 7: WP-230
Wave 8 parallel: WP-310, WP-320; finish WP-330, WP-340
Wave 9: WP-350
Wave 10: WP-400
Wave 11: WP-405
Wave 12: WP-410
```

## File Ownership

- Integrator: package metadata, shared exports, factory/operations/command-registry integration windows, final merges.
- Trust architect: interfaces/fake adapter/fidelity semantics.
- Contracts: current agent schema/definitions/registry + contracts.
- Generator: canonical fragments, root agents/prompts/skills, generated mirrors/build scripts.
- Route/core: side-effect-free context, config evidence, Route modules; `factory.ts` changes only in scheduled integrator window.
- Storage, authority, evidence, mediator, controller: exclusive respective `src/agents/run/**` modules/tests.
- OpenCode: only OpenCode source/tests/assets plus surface protected adapter.
- Claude: Claude surface, `src/cli/hooks/**`, Claude templates/manifests/source assets/tests; generated tree only through generator.
- Codex: Codex source/tests plus CLI Route patch through integrator window.
- pi: pi source/tests/assets.
- QA/docs: integration fixtures and docs; no runtime edits.

Integrator opens export/integration windows after Waves 2, 3, 7, and 8. Surface owners do not edit canonical contracts; runtime owners do not edit adapters.

## Feature Rollout And Migration

- `agents.route.enabled`: may default on only when read-only purity tests pass.
- `agents.run.enabled`: default false.
- Run state directories/version records are schema-versioned. Unknown newer major fails closed and remains preserved.
- Existing same-ID user agent/skill/config wins; emit collision diagnostic and lower fidelity. Never merge or overwrite.
- Previous binaries cannot acquire controller lease or mutate newer state.
- Kill switch denies new effects, cancels/drains active descendants, preserves artifacts/checkpoint, and leaves ordinary Orchestrate available.
- No persisted Run migration exists for first release. Future migration must be explicit, idempotent, backup-first, and rollback-tested.

## Objective Verification Commands

Baseline:

```bash
npm run build
npx jest tests/agents/capabilities.test.ts tests/surfaces/opencode/package-assets.test.ts --runInBand
npm run typecheck
npm test
npm run coverage
npm pack --dry-run --json
npm run mdocs:validate
git diff --check
```

Claude gate must include root hook suite:

```bash
npm run build:claude-plugin
npm run test:claude-code
npx jest tests/surfaces/claude-code-hooks.test.ts --runInBand
```

New required suites/scripts:

- `tests/agents/{contracts,compiler,route,run-store,authority,reports,mediator,controller,surface-fidelity}.test.ts`
- process tests for concurrent CAS, kill-after-effect, cancellation with child process, tamper, unknown metering;
- surface negative tests for forged approval, direct EO, EO->EO, leaf delegation, stale/replayed tickets, Bash/MCP/custom-tool bypass;
- Route no-write fixture on absent `mdocs/` and read-only filesystem;
- generator `--check` and clean-tree assertion before/after pack;
- downgrade truth-table fixtures for all surfaces.

Redaction oracle: only schema-allowlisted receipt fields persist; unknown/sensitive field causes persistence rejection, not best-effort masking.

Final:

```bash
npm run release:check
npm run mdocs:validate
git diff --check
```

Also run `mdocs_index_check` in check mode and require clean generated tree before/after package commands.

## Surface MVP

| Surface | Orchestrate | Route | Effectful Run default |
| --- | --- | --- | --- |
| OpenCode | Existing | Exact if no-write passes | Plan-only until trust adapter+mediator+store+meter probes pass |
| Claude Code | Existing | Exact if no-write passes | Plan-only until same probes pass |
| Codex | Advisory | Exact CLI/API if no-write passes | Plan-only |
| pi | Existing extension | Exact if no-write passes | Plan-only |

Trusted fake adapter validates controller core. No production surface must claim exact/supervised effectful Run in MVP.

## Definition Of Ready

Ready now for WP-000 baseline adoption. No user decision blocks core plan-only/Route/controller implementation.

Parallel feature implementation begins only after:

- WP-000 baseline passes;
- WP-090 trust interfaces and fake adapter land;
- WP-100 canonical contracts land;
- owners accept file boundaries.

Production effectful Run remains feature-gated until a surface passes every trust and adversarial probe.

## Referenced By

*Auto-generated by mdocs*

- extensible-harness-agents
