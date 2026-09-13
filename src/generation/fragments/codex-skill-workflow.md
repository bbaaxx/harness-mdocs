---
name: mdocs-workflow
description: Use when starting new mdocs-backed work, resuming initiatives, or managing the development workflow.
---

# Mdocs Workflow For Codex

Use mdocs as durable project memory when the user opts into initiative/wiki tracking.

Codex v1 enforcement is advisory. Do not edit project source files before `PLAN` unless the user explicitly overrides the workflow. `Bash` is audited but not gated by content. Use mdocs CLI commands to update progress after substantial actions.

**Configuration (when enforced):**
- Enforcement mode: `gate` (default) | `advisory` | `off`. Env: `MDOCS_ENFORCEMENT`.
- IDLE strictness: `mdocs.enforcement.idle` = `open` (default) | `readonly`. Env: `MDOCS_ENFORCEMENT_IDLE`.
- Config precedence: env > file > detected contract.
- Reset: `mdocs_reset` command → IDLE, clears active initiative.

**Workflow band:** `PLAN`/`EXECUTE`/`VERIFY`/`REPORT`/`COMPLETE` are treated as one "edits allowed" band; the engine does not enforce plan-vs-execute discipline.

Workflow steps:

1. `UNDERSTAND`: Clarify the request.
2. `DISCOVER`: Check `./mdocs/initiatives/INDEX.md` or run `mdocs status`.
3. `CONTEXT`: Read the initiative and related wiki entries, or run `mdocs dispatch <initiative-id>` when dispatch is available.
4. `PLAN`: Write or update the initiative plan.
5. `EXECUTE`: Do the implementation work.
6. `VERIFY`: Run project checks and `mdocs validate`.
7. `REPORT`: Update progress and write durable wiki learnings. Use `mdocs_ingest` to batch-compose wiki pages + overview/log sections from caller-supplied operations (no auto-prose — author all text yourself; ingest only records what you give it). For completed initiatives, use `lifecycle.graduate` to record learning into `wiki/overview.md` and `wiki/log.md`.
8. `COMPLETE`: Mark the initiative done only after validation. In directory-v2, this writes `status: complete`; `done` is the flat-v1 alias. Both mean completed — `isCompleted()` treats them equally.

Prefer CLI command access:

```bash
mdocs init
mdocs status
mdocs validate
mdocs command initiative.create --json '{"title":"Add authentication"}'
```

If CLI commands are unavailable, edit `./mdocs` files directly using the documented schema and repair indices before completion.
