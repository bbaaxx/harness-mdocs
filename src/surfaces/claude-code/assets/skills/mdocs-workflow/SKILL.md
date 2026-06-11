---
name: mdocs-workflow
description: Use when starting new mdocs-backed work, resuming initiatives, or managing the development workflow in Claude Code.
---

# Mdocs Workflow For Claude Code

Use mdocs as durable project memory when the user opts into initiative/wiki tracking.

**Enforcement is real.** Claude Code PreToolUse hooks actively BLOCK tool calls — this is not advisory:

- `Write` / `Edit` are blocked before the `PLAN` step (edits under `./mdocs/` are always allowed).
- Destructive `Bash` (e.g. `rm`, `mv`, `git commit`) is blocked before `COMPLETE`.
- `Read` / `Glob` / `Grep` are always allowed.

If a tool is blocked, advance the workflow rather than fighting the gate.

## Command access

Prefer the MCP tools. Fall back to the `mdocs` CLI via Bash. Last resort: edit `./mdocs/` files directly using the documented schema, then run `mdocs_validate`.

| Need | MCP tool |
|---|---|
| Current state / active initiative | `mdocs_status` |
| Resume work | `mdocs_resume` |
| Search memory | `mdocs_search` |
| Validate before completion | `mdocs_validate` |
| Assemble subagent context | `mdocs_dispatch` |
| Any core command | `mdocs` (with `command` + `args`) |

## Workflow steps

1. `UNDERSTAND`: Clarify the request.
2. `DISCOVER`: Call `mdocs_status` (or check `./mdocs/initiatives/INDEX.md`). Use `mdocs_resume` to pick up existing work.
3. `CONTEXT`: Read the initiative and related wiki entries, or call `mdocs_dispatch` for an assembled context bundle.
4. `PLAN`: Write or update the initiative plan via the `mdocs` tool (`initiative.create` / `initiative.update`). Edits to project source unblock at this step.
5. `EXECUTE`: Do the implementation work.
6. `VERIFY`: Run project checks and `mdocs_validate`.
7. `REPORT`: Update progress and write durable wiki learnings.
8. `COMPLETE`: Mark the initiative done only after validation passes.

Always call `mdocs_status` or `mdocs_resume` before resuming long-running work, and `mdocs_validate` before claiming work is complete.

## CLI fallback

```bash
mdocs status
mdocs validate
mdocs command initiative.create --json '{"title":"Add authentication"}'
```
