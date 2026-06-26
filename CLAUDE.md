# mdocs — Initiative and Wiki Memory

mdocs is active. Use the MCP tools for all mdocs operations.

## Quick Reference

- Check status: use the `mdocs_status` MCP tool
- Resume work: use the `mdocs_resume` MCP tool
- Create initiative: use the `mdocs` MCP tool with `command: "initiative.create"`
- Search memory: use the `mdocs_search` MCP tool
- Validate: use the `mdocs_validate` MCP tool

## Enforcement

Workflow enforcement is active via hooks. `Write`/`Edit` are blocked before the `PLAN` step and allowed from `PLAN` through `COMPLETE`. `Bash` is audited but not gated by content. Edits under `./mdocs/` are always allowed. Advance the workflow rather than working around a blocked tool.

**Configuration:**
- Enforcement mode: `gate` (default) | `advisory` | `off`. Env: `MDOCS_ENFORCEMENT`. `off` = CI escape hatch.
- IDLE strictness: `mdocs.enforcement.idle` = `open` (default; IDLE unconstrained) | `readonly` (IDLE = read tools + `./mdocs/` only). Env: `MDOCS_ENFORCEMENT_IDLE`.
- Config precedence: env > `.mdocs.json` file > detected contract. A `.mdocs.json` in the mdocs root sets `compatibility` (e.g. `initiativeRecordMode: "metadata-only"` to treat a consumer `_status.md` as thin lifecycle metadata — lifecycle keys only, no body-section injection), `standaloneCategories`, and `mdocsDirName`.
- Reset: `mdocs_reset` command → IDLE, clears active initiative. `resume()` auto-starts fresh cycles when prior initiative reached `COMPLETE` or at `IDLE`, landing at `UNDERSTAND`.

The engine treats `PLAN`/`EXECUTE`/`VERIFY`/`REPORT`/`COMPLETE` as one "edits allowed" band — it does not enforce plan-vs-execute discipline.

## Subagents

For subagent work, call `mdocs_dispatch` to assemble the handoff context, then pass it into the native subagent (`Task`, or `Agent` in some builds) prompt.
