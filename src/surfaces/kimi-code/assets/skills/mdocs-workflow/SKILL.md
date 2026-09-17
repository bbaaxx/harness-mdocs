---
name: mdocs-workflow
description: Use when starting new mdocs-backed work, resuming initiatives, or managing the development workflow in Kimi Code.
whenToUse: Starting new tracked work, resuming an initiative, or when the mdocs workflow gate blocks a Write/Edit
---

# Mdocs Workflow For Kimi Code

Use mdocs as durable project memory when the user opts into initiative/wiki tracking.

**Enforcement is real.** The Kimi Code `PreToolUse` hook actively BLOCKS tool calls (exit 2) — this is not advisory:

- `Write` / `Edit` are blocked before the `PLAN` step and allowed from `PLAN` through `COMPLETE` (edits under `./mdocs/` are always allowed).
- `Bash` is audited but not gated by content — the gate does not block commands by keyword.
- `Read` / `Grep` / `Glob` / `ReadMediaFile` are always allowed.

If a tool is blocked, advance the workflow (`mdocs_advance`) rather than fighting the gate.

**Configuration:**
- Enforcement mode: `gate` (default) | `advisory` | `off`. Env: `MDOCS_ENFORCEMENT`. `off` = CI escape hatch.
- IDLE strictness: `open` (default; IDLE unconstrained) | `readonly` (IDLE = read tools + `./mdocs/` only). Env: `MDOCS_ENFORCEMENT_IDLE`.
- Config precedence: env > `.mdocs.json` file > detected contract.
- Reset: `mdocs_reset` → IDLE, clears active initiative. `mdocs_resume` auto-starts fresh cycles when prior initiative reached `COMPLETE` or at `IDLE`, landing at `UNDERSTAND`.

The engine treats `PLAN`/`EXECUTE`/`VERIFY`/`REPORT`/`COMPLETE` as one "edits allowed" band — it does not enforce plan-vs-execute discipline; that is the agent's responsibility via the prompt.

## Command access

Use the mdocs MCP tools (they appear as `mcp__mdocs__*`). Fall back to the `mdocs` CLI via Bash. Last resort: edit `./mdocs/` files directly using the documented schema, then run `mdocs_validate`.

| Need | Tool |
|---|---|
| Current state / active initiative | `mcp__mdocs__mdocs_status` |
| Resume work | `mcp__mdocs__mdocs_resume` |
| Search memory | `mcp__mdocs__mdocs_search` |
| Validate before completion | `mcp__mdocs__mdocs_validate` |
| Assemble subagent context | `mcp__mdocs__mdocs_dispatch` |
| Batch-compose wiki pages + overview/log | `mcp__mdocs__mdocs_ingest` |
| Any core command | `mcp__mdocs__mdocs` (with `command` + `args`) |
| Advance to next step | `mcp__mdocs__mdocs_advance` (tool) or `mdocs step <step>` (CLI) |

## Advancing the workflow

Under the default `open` IDLE mode, enforcement binds once you leave `IDLE`
(at IDLE every tool is allowed). Under `readonly` (env `MDOCS_ENFORCEMENT_IDLE=readonly`),
IDLE already permits only read tools plus `./mdocs/` paths. The state machine
does not advance on its own — you must drive it forward:

- Tool: `mcp__mdocs__mdocs_advance` with `{ "step": "PLAN" }`
- CLI: `mdocs step PLAN`

Steps must be reached in order (no skipping, no going back): `UNDERSTAND →
DISCOVER → CONTEXT → PLAN → EXECUTE → VERIFY → REPORT → COMPLETE`. Build and test
commands (`npm`, `node`, `tsc`, `jest`, `git`) run at every step — `Bash` is
audited but not gated by content, so `rm`, `mv`, `git commit`, `git push`, and
`npm publish` are not blocked by the gate either. The "don't commit before
COMPLETE" guidance lives in this prompt, not a regex; the write/edit gate is the
real "plan before mutation" guardrail.

## Workflow steps

1. `UNDERSTAND`: Clarify the request.
2. `DISCOVER`: Call `mcp__mdocs__mdocs_status` (or check `./mdocs/initiatives/INDEX.md`). Use `mcp__mdocs__mdocs_resume` to pick up existing work.
3. `CONTEXT`: Read the initiative and related wiki entries, or call `mcp__mdocs__mdocs_dispatch` for an assembled context bundle.
4. `PLAN`: Write or update the initiative plan via the `mdocs` tool (`initiative.create` / `initiative.update`). Edits to project source unblock at this step.
5. `EXECUTE`: Do the implementation work.
6. `VERIFY`: Run project checks and `mdocs_validate`.
7. `REPORT`: Update progress and write durable wiki learnings. Use `mcp__mdocs__mdocs_ingest` to batch-compose wiki pages + overview/log sections from caller-supplied operations (no auto-prose — author all text yourself; ingest only records what you give it). For completed initiatives, use `lifecycle.graduate` to record learning into `wiki/overview.md` and `wiki/log.md` (tool: `mcp__mdocs__mdocs` with command `lifecycle.graduate`).
8. `COMPLETE`: Mark the initiative done only after validation passes. In directory-v2, this writes `status: complete`; `done` is the flat-v1 alias. Both mean completed — `isCompleted()` treats them equally.

Always call `mcp__mdocs__mdocs_status` or `mcp__mdocs__mdocs_resume` before resuming long-running work, and `mcp__mdocs__mdocs_validate` before claiming work is complete.

## CLI fallback

```bash
mdocs status
mdocs validate
mdocs command initiative.create --json '{"title":"Add authentication"}'
```
