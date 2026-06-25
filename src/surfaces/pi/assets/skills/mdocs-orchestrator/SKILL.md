---
name: mdocs-orchestrator
description: Primary mdocs workflow guide for pi sessions that need durable initiative and wiki memory.
---

# Mdocs Orchestrator For pi

This is the primary entry point for mdocs-backed sessions. Use `mdocs-workflow` for step detail and `mdocs-initiative` for file/schema detail.

## Start

Check for existing work first:

```
mdocs_status
```

or read `./mdocs/initiatives/INDEX.md`. To pick up prior work, call `mdocs_resume`.

If there is no active initiative and the user wants durable tracking, create one before substantial work:

```
mdocs  { "command": "initiative.create",
         "args": { "title": "Work title", "objective": "Clear objective",
                   "plan": ["Understand request","Inspect code","Implement","Verify"] } }
```

## During work

- Keep `nextAction`, `blockers`, and `handoffSummary` current via `initiative.update`.
- Enforcement is real: the `tool_call` extension event blocks `write`/`edit` before `PLAN` (allowed from PLAN through COMPLETE). `bash` is audited but not gated by content. Advance the workflow (`mdocs_advance`) instead of working around the gate. Edits under `./mdocs/` are always allowed.
- Configuration: Enforcement mode (`gate`|`advisory`|`off`, env `MDOCS_ENFORCEMENT`), IDLE strictness (`open`|`readonly`, env `MDOCS_ENFORCEMENT_IDLE`), precedence env>file>contract. Use `mdocs_reset` to clear active initiative.
- Record progress through the `mdocs` tool (`initiative.update` with `progressNote`); the `tool_result` extension event also logs tool activity to the audit log and appends a progress entry under a lock.

## Subagent dispatch (prompted)

pi has no native subagent primitive. For subagent work, assemble the handoff context first:

```
mdocs_dispatch  { "initiativeId": "<id>" }
```

The returned context bundle is carried forward manually — paste it into a new session (`/new` or `pi --session`), hand it to another invocation, or use it with `/skill:mdocs-orchestrator` in the follow-up session. A future version may add a `/mdocs-subagent` command that automates the session handoff; it is out of scope for the initial pi surface.

## Before marking complete

1. Run project verification commands.
2. Call `mdocs_validate`.
3. Write or update at least one **stable** wiki learning for the completed initiative. Use `mdocs_ingest` to batch-compose wiki pages + overview/log sections from caller-supplied operations (no auto-prose — author all text yourself). For completed initiatives, use `lifecycle.graduate` to record learning into `wiki/overview.md` and `wiki/log.md`.
4. Mark done: `mdocs { "command": "initiative.done", "args": { "id": "<id>" } }`. In directory-v2, this writes `status: complete`; `done` is the flat-v1 alias. Both mean completed — `isCompleted()` treats them equally.
