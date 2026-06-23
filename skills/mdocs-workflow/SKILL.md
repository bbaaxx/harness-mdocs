---
name: mdocs-workflow
description: Use when starting new work, creating tasks, or managing the development workflow. Triggers on "start work", "new task", "begin initiative", "work on".
---

# Mdocs Workflow

## Overview

The mdocs workflow is a 9-step process for AI-assisted development:

1. **UNDERSTAND** — Clarify the request. Ask questions if ambiguous.
2. **DISCOVER** — Check `./mdocs/initiatives/` for related work. Use `mdocs_resume` to pick up where the last agent left off. Offer to resume or create.
3. **CONTEXT** — Read the initiative and related wiki entries. Use `mdocs_dispatch` to get assembled context with search-ranked memory and recent activity.
4. **PLAN** — Write an implementation plan to the initiative file.
5. **EXECUTE** — Dispatch subagents with assembled context via Task tool. `mdocs_dispatch` now includes retrieved memory, handoff summary, blockers, and recent audit events.
6. **VERIFY** — Check results (lint, tests). Run `mdocs_validate` to check initiative/wiki integrity and graph cross-links. Loop if needed.
7. **REPORT** — Write wiki entries for artifacts, update initiative. For done initiatives, ensure at least one wiki entry with `lifecycle: stable` captures durable learnings.
8. **COMPLETE** — Offer to commit, mark initiative done. Graph linter verifies done initiatives have stable wiki learnings.

## Rules

- Never skip steps. Each step sets a checkpoint.
- Read tools are always allowed. Write/Edit tools require PLAN state (allowed from PLAN through COMPLETE).
- Bash is audited but not gated by content.
- Commits are not gated by enforcement (guidance only).
- If no active initiative exists, workflow is opt-in.
- Resume-first: start DISCOVER with `mdocs_resume` or `mdocs_status` to see active work, blockers, and next actions. `resume()` auto-starts fresh cycles when prior initiative reached COMPLETE or at IDLE.
- Use `mdocs_reset` to clear active initiative and return to IDLE.
- Verification includes graph linting: cross-links, backlinks, and completion gates.

**Configuration (when enforced):**
- Enforcement mode: `gate` (default) | `advisory` | `off`. Env: `MDOCS_ENFORCEMENT`.
- IDLE strictness: `mdocs.enforcement.idle` = `open` (default) | `readonly`. Env: `MDOCS_ENFORCEMENT_IDLE`.
- Config precedence: env > file > detected contract.

**Workflow band:** `PLAN`/`EXECUTE`/`VERIFY`/`REPORT`/`COMPLETE` are treated as one "edits allowed" band; the engine does not enforce plan-vs-execute discipline.

## Subagent Dispatch

When dispatching subagents, include:
- Initiative objective and current plan items
- Relevant wiki entries
- Handoff summary, blockers, and next action (v2 metadata)
- Retrieved memory (search-ranked related context)
- Recent audit events for the initiative
- Current step constraints
- Verification criteria

## Maintenance Commands

Use the `mdocs` command tool for safe filesystem-changing maintenance:
- `initiative.delete` removes an initiative and regenerates `initiatives/INDEX.md`.
- `initiative.archive` moves a done initiative to `initiatives/archive/` and regenerates active/archive indices.
- `wiki.delete` removes a wiki entry and regenerates wiki indices.
- `wiki.list` lists wiki entries, optionally filtered by category.
- `wiki.link` creates a bidirectional link between an initiative and a wiki entry (updates both `related_wiki` and `related_initiatives`).
- `wiki.xref` creates a cross-reference link between two wiki entries (updates `related_wiki` frontmatter).
- `index.sync` force-regenerates initiative and wiki indices after direct file edits.

## Bidirectional Linking

When connecting initiatives to wiki knowledge:

1. **Initiative → Wiki:** Add `related_wiki: ["category/id"]` to the initiative frontmatter.
2. **Wiki → Initiative:** The wiki entry automatically gets a `## Referenced By` section listing all linking initiatives. Use `wiki.link` to ensure both sides are updated atomically:
   ```
   mdocs { command: 'wiki.link', args: { initiativeId: 'my-initiative', wikiSlug: 'architecture/pattern' } }
   ```
3. **Wiki → Wiki:** Reference other wiki entries with `[[category/id]]` or `[text](category/id)` in the body. Use `wiki.xref` to establish bidirectional wiki cross-references:
   ```
   mdocs { command: 'wiki.xref', args: { fromSlug: 'architecture/pattern', toSlug: 'guides/usage' } }
   ```

The `## Referenced By` section in wiki entries is auto-generated and updated on create/update. It is stripped when reading via `wiki.read()` so the `content` field contains only user-written content.

## INDEX Consistency

When files are edited directly (bypassing mdocs commands), indices can become stale:

1. **Check consistency:** Use `mdocs_index_check` to detect missing files, orphans, or staleness:
   ```
   mdocs_index_check({ mode: 'check' })
   ```
2. **Repair indices:** If inconsistencies are found, use repair mode to regenerate all INDEX files:
   ```
   mdocs_index_check({ mode: 'repair' })
   ```
3. The tool tracks last-sync timestamp in `mdocs/.index-meta.json`.
4. Always run `mdocs_validate` after direct file edits to catch broken references.
