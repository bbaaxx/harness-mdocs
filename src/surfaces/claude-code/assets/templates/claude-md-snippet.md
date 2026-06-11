# mdocs — Initiative and Wiki Memory

mdocs is active. Use the MCP tools for all mdocs operations.

## Quick Reference

- Check status: use the `mdocs_status` MCP tool
- Resume work: use the `mdocs_resume` MCP tool
- Create initiative: use the `mdocs` MCP tool with `command: "initiative.create"`
- Search memory: use the `mdocs_search` MCP tool
- Validate: use the `mdocs_validate` MCP tool

## Enforcement

Workflow enforcement is active via hooks. `Write`/`Edit` are blocked before the `PLAN` step, and destructive `Bash` is blocked before `COMPLETE`. Edits under `./mdocs/` are always allowed. Advance the workflow rather than working around a blocked tool.

## Subagents

For subagent work, call `mdocs_dispatch` to assemble the handoff context, then pass it into the native subagent (`Task`, or `Agent` in some builds) prompt.
