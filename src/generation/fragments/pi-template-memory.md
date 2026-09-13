# mdocs — Initiative and Wiki Memory (pi)

mdocs is active. Use the pi extension custom tools for all mdocs operations.

## Quick Reference

- Check status: use the `mdocs_status` tool
- Resume work: use the `mdocs_resume` tool
- Create initiative: use the `mdocs` tool with `command: "initiative.create"`
- Search memory: use the `mdocs_search` tool
- Validate: use the `mdocs_validate` tool
- Advance the workflow: use the `mdocs_advance` tool (e.g. `{ "step": "PLAN" }`)

## Enforcement

Workflow enforcement is active via the pi `tool_call` extension event. `write`/`edit` are blocked before the `PLAN` step and allowed from `PLAN` through `COMPLETE`. `bash` is audited but not gated by content. Edits under `./mdocs/` are always allowed. Advance the workflow (`mdocs_advance`) rather than working around a blocked tool.

**Configuration:** Enforcement mode `gate` (default) | `advisory` | `off` (env `MDOCS_ENFORCEMENT`). IDLE strictness `open` (default) | `readonly` (env `MDOCS_ENFORCEMENT_IDLE`). Config precedence: env > `.mdocs.json` file > detected contract. A `.mdocs.json` in the mdocs root may set `compatibility` (e.g. `initiativeRecordMode: "metadata-only"` to treat a consumer `_status.md` as thin lifecycle metadata — lifecycle keys only, no body-section injection), `standaloneCategories`, and `mdocsDirName`. Reset: `mdocs_reset` tool.

## Subagents

pi has no native subagent primitive. For subagent work, call `mdocs_dispatch` to assemble the handoff context, then carry the returned context bundle into the follow-up session manually (paste it into a new session or another invocation).
