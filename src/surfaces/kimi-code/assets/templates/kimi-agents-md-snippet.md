# mdocs — Initiative and Wiki Memory (Kimi Code)

mdocs is active. Use the mdocs MCP tools (`mcp__mdocs__*`) for all mdocs operations.

## Quick Reference

- Check status: use the `mcp__mdocs__mdocs_status` tool
- Resume work: use the `mcp__mdocs__mdocs_resume` tool
- Create initiative: use the `mcp__mdocs__mdocs` tool with `command: "initiative.create"`
- Search memory: use the `mcp__mdocs__mdocs_search` tool
- Validate: use the `mcp__mdocs__mdocs_validate` tool
- Advance the workflow: use the `mcp__mdocs__mdocs_advance` tool (e.g. `{ "step": "PLAN" }`)

## Enforcement

Workflow enforcement is active via the Kimi Code `PreToolUse` hook. `Write`/`Edit` are blocked before the `PLAN` step and allowed from `PLAN` through `COMPLETE`. `Bash` is audited but not gated by content. Edits under `./mdocs/` are always allowed. Advance the workflow (`mdocs_advance`) rather than working around a blocked tool.

**Configuration:** Enforcement mode `gate` (default) | `advisory` | `off` (env `MDOCS_ENFORCEMENT`). IDLE strictness `open` (default) | `readonly` (env `MDOCS_ENFORCEMENT_IDLE`). Config precedence: env > `.mdocs.json` file > detected contract. A `.mdocs.json` in the mdocs root may set `compatibility` (e.g. `initiativeRecordMode: "metadata-only"` to treat a consumer `_status.md` as thin lifecycle metadata — lifecycle keys only, no body-section injection), `standaloneCategories`, and `mdocsDirName`. Reset: `mcp__mdocs__mdocs_reset` tool.

## Subagents

For subagent work, call `mcp__mdocs__mdocs_dispatch` to assemble the handoff context, then pass the returned context bundle into the native `Agent` tool prompt.
