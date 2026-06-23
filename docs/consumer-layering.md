# Consumer Layering

`harness-mdocs` provides a generic initiative and wiki memory system. Workspaces layer their own conventions, knowledge bases, and task sources on top without modifying the package internals.

## Core Design

The plugin is **self-contained** and **composable**:
- `mdocs/` directory is isolated — plugin hooks and MCP tools operate only within this tree
- CLAUDE.md snippet is additive — it extends project instructions, not replaces them
- Hooks coexist — multiple SessionStart hooks run and their context is concatenated
- External task sources integrate alongside mdocs initiatives — they serve different purposes

This means you can add workspace-specific docs, hooks, and workflows without conflicting with harness-mdocs.

## Composition with a Sibling Knowledge Base

Workspaces often maintain their own documentation alongside `mdocs/`. The plugin does not interfere with sibling directories.

### Layout Pattern

```text
my-project/
├── mdocs/              # harness-mdocs memory (isolated)
│   ├── initiatives/
│   └── wiki/
├── docs/               # workspace knowledge (independent)
│   ├── architecture/
│   └── guides/
├── .claude/
│   ├── settings.json
│   └── CLAUDE.md
└── README.md
```

### Tool Routing

- harness-mdocs MCP tools only read/write `mdocs/`
- Your workspace docs live in separate directories
- No tool conflict — each operates on its own tree

### Integration Strategies

1. **Wiki cross-links** — reference external docs from mdocs wiki entries:
   ```markdown
   ---
   id: auth-flow
   title: Auth Flow
   category: architecture
   ---
   
   See `../../docs/architecture/auth.md` for detailed diagrams.
   ```

2. **CLAUDE.md pointers** — add workspace-specific orientation after the snippet:
   ```markdown
   # mdocs — Initiative and Wiki Memory
   
   [snippet content]
   
   ## Project-Specific Docs
   
   Architecture docs are in `docs/architecture/`. Start with `docs/architecture/overview.md`.
   ```

The key principle: **mdocs/ is self-contained**. Your workspace directories live beside it, not inside it.

## External Task List Integration

Many workspaces track tasks in external systems (GitHub issues, Jira, Linear, etc.). These coexist with mdocs initiatives — they serve different roles.

### Roles

| External task list | mdocs initiatives |
| --- | --- |
| Incoming work stream | Durable collaboration memory |
| Issue tracking, triage, assignment | Deep context, progress, handoff state |
| Often external to repo | Lives in `mdocs/initiatives/` |
| Short-lived, status-driven | Long-lived, learning-oriented |

### Integration Patterns

**Pattern 1: External → mdocs**

When an issue becomes active work, create an initiative:

```markdown
# GitHub issue #142

Created initiative `github-142-refactor-auth` to track the implementation work.
The issue remains the source of truth for status; the initiative holds deep context.
```

The initiative links back to the external source in its frontmatter:

```markdown
---
id: github-142-refactor-auth
title: Refactor auth (GitHub #142)
external_url: https://github.com/org/repo/issues/142
---
```

**Pattern 2: mdocs → external**

When an initiative completes, update the external tracker:

```markdown
# Completed initiative

Done implementing `github-142-refactor-auth`. Update GitHub #142 status and link back to the initiative for implementation details.
```

**Pattern 3: Parallel tracking**

Keep both systems in sync during active work:

```markdown
## Progress Log

- [2026-06-23] Started implementation. GitHub issue: https://github.com/org/repo/issues/142
- [2026-06-24] Middleware complete. Updated issue with progress note.
- [2026-06-25] Initiative done. Close issue.
```

### No Conflict

External task lists and mdocs initiatives do not compete:
- The external system is the **incoming stream** and **status tracker**
- mdocs initiatives are the **deep work memory** and **handoff vehicle**
- They reference each other; one does not replace the other

## Consumer SessionStart Hooks

Claude Code runs **all matching SessionStart hooks** and concatenates their `additionalContext`. You can add your own workspace orientation hook alongside the harness-mdocs orientation hook (G1).

### How SessionStart Hooks Compose

From [Claude Code hooks](https://code.claude.com/docs/en/hooks):

> When multiple hooks match an event, Claude Code executes all of them and combines their output. For SessionStart, the `additionalContext` fields are concatenated.

### Example: Adding Workspace Orientation

Your workspace hook (`scripts/hooks/session-start.js`):

```javascript
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const projectRoot = process.env.MDOCS_PROJECT_DIR || process.cwd();
const orientationPath = path.join(projectRoot, 'docs', 'orientation.md');

try {
  if (fs.existsSync(orientationPath)) {
    const orientation = fs.readFileSync(orientationPath, 'utf8');
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: orientation
      }
    }));
  }
} catch (error) {
  // Fail open — no stdout means no additional context
  process.exit(0);
}
```

Register in `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node ${workspaceFolder}/scripts/hooks/session-start.js"
          }
        ]
      }
    ]
  }
}
```

### Combined Context at Session Start

When a session starts, Claude Code receives concatenated context from both hooks:

```text
[ harness-mdocs orientation: initiative counts, active initiative, wiki count ]
[ Your workspace orientation: project-specific guidance, architecture pointers ]
```

### Best Practices

- **Keep each hook compact** — the combined context caps at 10,000 characters
- **Avoid overlap** — don't duplicate what the other hook provides
- **Don't depend on order** — hook execution order is not guaranteed
- **Fail open** — if your hook errors, exit 0 with no stdout rather than crashing session start

The harness-mdocs orientation hook provides a pointer to mdocs state. Your workspace hook should provide pointers to your own conventions and docs.

## CLAUDE.md Snippet is Additive

`src/surfaces/claude-code/assets/templates/claude-md-snippet.md` is designed to be **composed into** your project's CLAUDE.md, not replace it.

### Snippet Content

The snippet contains:
- mdocs quick reference (which MCP tools to use)
- Workflow enforcement explanation
- Subagent dispatch pattern

### Safe Extension Pattern

Copy the snippet into your CLAUDE.md, then append workspace sections:

```markdown
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

**Configuration:** Enforcement mode `gate` (default) | `advisory` | `off` (env `MDOCS_ENFORCEMENT`). IDLE strictness `open` (default) | `readonly` (env `MDOCS_ENFORCEMENT_IDLE`). Config precedence: env > file > detected contract. Reset: `mdocs_reset` command.

## Subagents

For subagent work, call `mdocs_dispatch` to assemble the handoff context, then pass it into the native subagent (`Task`, or `Agent` in some builds) prompt.

---

# Project-Specific Conventions

## Testing

Run tests with `npm test`. Use `npm run test:watch` for TDD.

## Code Style

Follow the style guide in `docs/contributing/style.md`.

## Architecture

Start with `docs/architecture/overview.md` for system context.
```

### What NOT to Edit

The snippet's **tool routing lines** are tuned for the MCP server layout. Don't modify:

- The MCP tool names (`mdocs_status`, `mdocs_resume`, etc.)
- The enforcement configuration precedence
- The subagent dispatch pattern

These lines must match the actual MCP server interface. Change them only if you're customizing the server itself.

### Re-merging on Upgrade

When you upgrade harness-mdocs, the snippet may gain new lines. Re-merge by:

1. Fetch the latest snippet from `node_modules/harness-mdocs/src/surfaces/claude-code/assets/templates/claude-md-snippet.md`
2. Replace the old snippet section in your CLAUDE.md
3. Re-apply your workspace extensions below it

Your workspace sections remain intact; only the mdocs section updates.

## Summary

Consumer layering follows three principles:

1. **Sibling directories, not nested** — your docs live beside `mdocs/`, not inside it
2. **Coexisting systems, not replacement** — external task lists and mdocs initiatives serve different roles
3. **Composed context, not conflict** — multiple SessionStart hooks concatenate; CLAUDE.md snippet extends project instructions

The plugin stays generic. Your workspace adds its own layer on top.
