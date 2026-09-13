---
name: mdocs-orchestrator
description: Primary mdocs workflow guide for Claude Code sessions that need durable initiative and wiki memory.
---

# Mdocs Orchestrator For Claude Code

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
- Enforcement is real: PreToolUse hooks block `Write`/`Edit` before `PLAN` (allowed from PLAN through COMPLETE). `Bash` is audited but not gated by content. Advance the workflow instead of working around the gate. Edits under `./mdocs/` are always allowed.
- Configuration: Enforcement mode (`gate`|`advisory`|`off`, env `MDOCS_ENFORCEMENT`), IDLE strictness (`open`|`readonly`, env `MDOCS_ENFORCEMENT_IDLE`), precedence env>file>contract. Use `mdocs_reset` to clear active initiative.
- Record progress through the `mdocs` tool (`initiative.update` with `progressNote`); the PostToolUse hook also logs tool activity to the audit log.

## Subagent dispatch (native)

For subagent work, use Claude Code's native subagent dispatch (the `Task` tool, named `Agent` in some builds). Assemble the handoff context first:

```
mdocs_dispatch  { "initiativeId": "<id>" }
```

Pass the returned context bundle into the subagent prompt so it inherits objective, plan, blockers, next action, related wiki, and recent activity.

## Before marking complete

1. Run project verification commands.
2. Call `mdocs_validate`.
3. Write or update at least one **stable** wiki learning for the completed initiative. Use `mdocs_ingest` to batch-compose wiki pages + overview/log sections from caller-supplied operations (no auto-prose — author all text yourself). For completed initiatives, use `lifecycle.graduate` to record learning into `wiki/overview.md` and `wiki/log.md`.
4. Mark done: `mdocs { "command": "initiative.done", "args": { "id": "<id>" } }`. In directory-v2, this writes `status: complete`; `done` is the flat-v1 alias. Both mean completed — `isCompleted()` treats them equally.
