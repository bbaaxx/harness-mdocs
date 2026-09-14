---
id: "run-action-mediation"
title: "Protected Run action mediation"
category: "architecture"
created: "2026-09-14"
updated: "2026-09-14"
related_initiatives: ["extensible-harness-agents"]
tags: ["agents","run","mediation","effects","authority","receipts","security","idempotency"]
---

## Purpose
WP-225 provides mandatory host-owned pre-effect mediation for every Run side effect and child spawn. It connects WP-210 live authority to WP-220 strict receipts without granting workers direct access to protected stores, ticket bodies, leases, executors, or receipt evidence.

## Public and host-only boundaries
- Public `ActionMediator` accepts a strict `StructuredAction`, persists authorization intent, executes by opaque reservation, and returns only hashed action/receipt references plus result timing/classification. Public serialization excludes ticket handles, lineage, lease refs/fences, credentials, provider reservation IDs, raw authority, and full evidence envelopes.
- `createActionMediator`, `ActionMediatorHost`, protected receipt lookup, authority verifier, executor registry, store writer, and resolved authority snapshots remain internal and are omitted from safe package barrels.
- No production executor ships in WP-225. Fake executors perform no shell, network, Git, package, MCP, filesystem, or process primitive. Surfaces remain plan-only until WP-310/WP-320 provide protected adapters and WP-300 probes verify them.

## Structured action contract
- Operations are closed and allowlisted: filesystem write/delete, process execution, network request, Git mutation, package hook, agent spawn, tool invocation.
- Staged payloads are cryptographically bound: filesystem writes include content digest and declared bytes; network requests include payload digest; tool calls include arguments digest; spawns include request digest. Process argv, Git args, and package hook are fully represented in the normalized action digest.
- Host executor policy validates exact request shape and derives required credential classes. Caller side-effect labels cannot suppress credential checks.
- Canonical protected resource bindings are digest-based. Executor actual resources must equal declared protected bindings; workspace targets and mutations must remain inside both action and authority write sets.

## Protected saga
1. Validate kill switch and strict action/options.
2. Preview current authority, approval, policy, lease, graph/cancellation generation, write set, credentials, topology, and budgets.
3. Persist canonical intent in fenced protected CAS storage before any adapter invocation.
4. Revalidate before execution, durably claim `executing`, then invoke one-shot effect guard.
5. Effect guard performs approval-first live authority verification and LEAF nonce claim, then rechecks approval. Adapter must call guard exactly once after preparation and perform no await/effect before protected primitive.
6. Re-read authority after effect to accept legal lease heartbeat extension or classify cancellation/revocation/fence drift as uncertainty.
7. Validate executor result, workspace fingerprints, metadata redaction, resource boundaries, spawn ticket binding, and strict WP-220 receipt before durable completion.

Terminal receipts are immutable. Exact replay is idempotent; conflicting replay never overwrites evidence. An `executing` action without authoritative adapter reconciliation becomes uncertain after restart. Store/CAS ambiguity, executor throw, invalid result, post-effect authority drift, or receipt persistence ambiguity never returns trusted success. Protected aggregate canonical bytes are capped below store maximum; capacity exhaustion fails before effect.

## Authority and topology
- Current ticket and every ancestor must remain active and unexpired. Lease ref/generation/fence, graph epoch, cancellation generation, approvals, operation/tool/credential scopes, and write/criteria bindings are checked again at effect boundary.
- Strict topology remains `PLAN_ROOT -> EXECUTION -> LEAF`; LEAF cannot spawn.
- Spawn consumes exactly one active pre-issued WP-210 child ticket bound to current parent lease and graph edge. Mediator cannot mint authority. Protected CAS prevents a child ticket from binding to multiple spawn actions. Success receipts bind exact child ticket; failure/uncertainty receipts bind none.
- Issued LEAF tickets are previewed without nonce consumption. Effect guard claims only after durable intent and policy/approval checks; indeterminate claim commits reconcile from protected state.

## Budgets and usage boundary
- One CAS enforces run-global, exact-authority local, and EO-lineage action limits. EO lineage counts EO direct actions plus every child LEAF action, preventing sibling overspend. Persisted denied/uncertain attempts retain conservative charges.
- Delegated tickets retain their one WP-210 ticket-wide pending usage reservation across multiple actions. Controller-root nodes use deterministic protected synthetic pending reservations because WP-210 ledger accounts are ticket-scoped.
- WP-225 receipts are strict valid WP-220 evidence with pending usage. Pending evidence deliberately blocks final report completion. WP-230 owns aggregate usage reconciliation and monotonic committed receipt projection; WP-225 neither closes a multi-action ticket after its first action nor claims final report acceptance.

## Verification
Independent security reviews drove fixes for usage lifecycle, ordered lineage, capability projection, approval and authority races, child-ticket lease binding, terminal evidence immutability, payload staging, credential policy, EO subtree budgets, expiry, post-effect heartbeat handling, and storage bounds. Final review issue—approval revocation during final backend verification—was closed with a second fail-closed approval read.

Release gate passed 60 suites and 1,329 tests. Typecheck, build, lint, generated-asset checks, mdocs validation, package dry-run (500 files), and `git diff --check` passed. Known unrelated warning remains: done initiative `release-0-7-1` has no stable wiki learning.

## Referenced By

*Auto-generated by mdocs*

- extensible-harness-agents
