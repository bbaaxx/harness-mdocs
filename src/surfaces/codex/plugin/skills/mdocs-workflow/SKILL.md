---
name: mdocs-workflow
description: Use when starting new mdocs-backed work, resuming initiatives, or managing the development workflow.
---

# Mdocs Workflow For Codex

Use mdocs as durable project memory when the user opts into initiative/wiki tracking.

Codex v1 enforcement is advisory. Do not edit project source files before `PLAN` unless the user explicitly overrides the workflow. Defer destructive shell operations until `COMPLETE`. Use mdocs CLI commands to update progress after substantial actions.

Workflow steps:

1. `UNDERSTAND`: Clarify the request.
2. `DISCOVER`: Check `./mdocs/initiatives/INDEX.md` or run `mdocs status`.
3. `CONTEXT`: Read the initiative and related wiki entries, or run `mdocs command dispatch --json '{"initiativeId":"..."}'` when dispatch is available.
4. `PLAN`: Write or update the initiative plan.
5. `EXECUTE`: Do the implementation work.
6. `VERIFY`: Run project checks and `mdocs validate`.
7. `REPORT`: Update progress and write durable wiki learnings.
8. `COMPLETE`: Mark the initiative done only after validation.

Prefer CLI command access:

```bash
mdocs init
mdocs status
mdocs validate
mdocs command initiative.create --json '{"title":"Add authentication"}'
```

If CLI commands are unavailable, edit `./mdocs` files directly using the documented schema and repair indices before completion.
