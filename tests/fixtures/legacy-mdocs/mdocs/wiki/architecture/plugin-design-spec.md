---
id: "plugin-design-spec"
title: "Original Plugin Design Spec"
category: "architecture"
created: "2026-05-27"
updated: "2026-06-03"
related_initiatives: ["install-mdocs","align-implementation-with-philosophy","fix-local-dogfooding-agent-discovery","fix-v1-opencode-compatibility","evaluate-pr-3-wiki-orphan-fix","fix-wiki-index-consistency-check","fix-opencode-runtime-tool-registration","prepare-v1-3-0-release","fix-v1-3-0-agent-discovery-regression"]
tags: ["blueprint","architecture","design","history"]
lifecycle: "stable"
knowledge_type: "historical-blueprint"
confidence: "high"
source_initiatives: ["install-mdocs","align-implementation-with-philosophy"]
---

> **Historical Note:** This document is the original design specification created *before* the plugin was implemented. It served as the blueprint for building opencode-mdocs. Some details may differ from the final implementation.

## Overview

An opencode plugin that implements a 2-layer knowledge system (initiatives + wiki) and enforces a 9-step workflow for AI-assisted development. The plugin is self-referential: its own development is tracked using its system.

## Architecture

**Approach: Plugin-Centric**

The plugin is the orchestrator. It owns the workflow state machine, enforces gates, and spawns subagents. Skills provide instructions, agents provide personas.

```
opencode-mdocs (npm package)
├── src/
│   ├── index.ts              ← plugin entry point
│   ├── plugin.ts             ← hook registrations
│   ├── workflow.ts           ← state machine engine
│   ├── mdocs.ts              ← /mdocs CRUD operations
│   ├── initiative.ts         ← initiative read/write/search
│   ├── wiki.ts               ← wiki read/write/index
│   ├── subagent.ts           ← context assembly for Task tool
│   └── types.ts              ← shared types
├── templates/
│   ├── initiative.md         ← template for new initiatives
│   └── wiki-entry.md         ← template for wiki entries
├── skills/
│   ├── mdocs-workflow/
│   │   └── SKILL.md
│   └── mdocs-initiative/
│       └── SKILL.md
└── agents/
    └── mdocs-orchestrator.md
```

## Knowledge System

### Directory Structure

```
/mdocs/
├── initiatives/
│   ├── INDEX.md                                    ← auto-generated
│   ├── add-authentication-system--2025-05-24.md
│   └── fix-login-redirect-bug--2025-05-25.md
└── wiki/
    ├── INDEX.md                                    ← auto-generated
    ├── architecture/
    │   ├── INDEX.md
    │   └── plugin-design.md
    ├── decisions/
    │   ├── INDEX.md
    │   └── why-plugin-centric.md
    └── runbooks/
        ├── INDEX.md
        └── how-to-add-initiative.md
```

### Initiative File Format

Filename: `<slug>--<YYYY-MM-DD>.md` (slug derived from title, descriptive and sortable)

```markdown
---
id: add-authentication-system
title: Add authentication system
status: active
created: 2025-05-24
updated: 2025-05-24
owner: human-name
tags: [auth, security]
related_wiki: [architecture/plugin-design]
---

## Objective
Add JWT-based auth to the API.

## Plan
1. Research auth libraries
2. Implement middleware
3. Add tests

## Progress Log
- [2025-05-24] Created initiative, researched options
- [2025-05-25] Implemented middleware (subagent: builder)

## Artifacts
- wiki/decisions/why-jwt.md
- wiki/runbooks/auth-setup.md
```

**Status values:** `active` | `paused` | `done`

### Wiki Entry Format

```markdown
---
id: plugin-design
title: Plugin Architecture Design
category: architecture
created: 2025-05-24
updated: 2025-05-24
related_initiatives: [add-authentication-system]
tags: [plugin, architecture]
lifecycle: stable              # optional: draft | stable | superseded | needs-review
knowledge_type: architecture   # optional: architecture | decision | how-to | reference | roadmap | note
confidence: high               # optional: low | medium | high
source_initiatives: [id-a, id-b]  # optional: which initiatives produced this knowledge
supersedes: [older-entry-id]    # optional: which entry this replaces
related_wiki: [sibling-id]     # optional: cross-references to other wiki entries
---

## Overview
The plugin follows a plugin-centric architecture...
```

**Field reference** (full `WikiEntry` schema in `src/types.ts`):

| Field | Type | Notes |
|---|---|---|
| `id`, `title`, `category`, `created`, `updated` | string | Required. `category` becomes the wiki subdirectory. |
| `related_initiatives` | string[] | Optional. Backlinks from this entry to initiatives. Does **not** silence orphan warnings by itself — only an initiative's `related_wiki` array pointing back to this entry counts as a real reference. |
| `tags` | string[] | Optional. Used by full-text search and initiative matching. |
| `lifecycle` | enum | Optional. `draft` \| `stable` \| `superseded` \| `needs-review`. The linter uses `stable` to identify settled learnings; `validate()` also uses it as an opt-out from the orphan check (see Orphan Detection below). |
| `knowledge_type` | enum | Optional. Used for filtering and display. |
| `confidence` | enum | Optional. `low` \| `medium` \| `high`. |
| `source_initiatives` | string[] | Optional. Provenance: which initiatives produced this knowledge. Synonym: `sources` (see below). |
| `sources` | string[] | Optional. Alias for `source_initiatives`. Useful for human authors who prefer the shorter name; the parser accepts either. |
| `supersedes` | string[] | Optional. Forward reference to entries this one replaces. |
| `related_wiki` | string[] | Optional. Cross-references to sibling wiki entries (category/id pairs). |

### Orphan Detection

`WikiManager.validate()` flags any wiki entry that is not referenced by any initiative. An entry is considered **referenced** if **any** of the following holds:

1. Some initiative's `related_wiki` array contains this entry's `category/id` pair (the canonical bidirectional link).
2. The entry itself has a non-empty `source_initiatives` (or `sources`) field.
3. The entry has `lifecycle: stable` — interpreted as "settled knowledge that stands on its own."
4. The entry's `category` is listed in the constructor's `standaloneCategories` option — interpreted as a project-wide category exempt from initiative anchoring.

Configured example (programmatic consumers):

```ts
import { createPlugin } from 'opencode-mdocs';

const plugin = createPlugin(baseDir, {
  standaloneCategories: ['repo', 'system', 'glossary']
});
```

The default has no standalone categories — the option must be supplied explicitly to opt in.

### Indices

- `/mdocs/initiatives/INDEX.md` — auto-generated table of all initiatives with status, date, tags
- `/mdocs/wiki/INDEX.md` — auto-generated categorized list of all wiki entries
- `/mdocs/wiki/<category>/INDEX.md` — per-category index

Indices regenerated on every initiative/wiki write.

## Workflow State Machine

```
IDLE → UNDERSTAND → DISCOVER → CONTEXT → PLAN → EXECUTE → VERIFY → REPORT → COMPLETE
```

### Steps

1. **IDLE** — Waiting for request
2. **UNDERSTAND** — Clarify intent (may ask user questions if request is ambiguous)
3. **DISCOVER** — Scan `/mdocs/initiatives/` for related initiatives using fuzzy title matching (Levenshtein distance on slug words) and tag overlap (Jaccard similarity on tags array)
   - If match score > 0.6: offer to resume existing initiative
   - If not found: offer to create new initiative
4. **CONTEXT** — Read initiative file + related wiki entries, assemble context
5. **PLAN** — Create implementation plan, write to initiative
6. **EXECUTE** — Handoff to subagents via Task tool with assembled context
7. **VERIFY** — Check results (lint, typecheck, tests if available)
   - If not done: loop back to EXECUTE with feedback
   - If done: proceed
8. **REPORT** — Write wiki entries for artifacts, update initiative progress log
9. **COMPLETE** — Offer to commit changes, mark initiative as `done`

### Enforcement Rules

- Each step sets a checkpoint in `.workflow-state.json`
- `tool.execute.before` checks workflow state:
  - READ tools (read, glob, grep, list): always allowed
  - WRITE tools (edit, write): blocked until state >= PLAN
  - BASH tools: non-destructive commands (ls, cat, echo) always allowed; destructive commands (rm, mv, git commit) blocked until state >= COMPLETE
  - If workflow is IDLE (no active initiative), all tools allowed — workflow is opt-in per task
- Workflow state persisted in `/mdocs/.workflow-state.json`
- **Escape hatch:** If no active initiative exists (IDLE state), the workflow is opt-in — all tools work normally. Users opt into the workflow by creating or resuming an initiative.

## Plugin Hooks

```ts
export default (async ({ client, project, directory, $ }) => {
  const workflow = new WorkflowEngine(directory)
  const mdocs = new MdocsManager(directory)

  return {
    // Initialize /mdocs structure on first run
    config: (cfg) => {
      // Inject mdocs-orchestrator agent and skills into config
    },

    // Gate enforcement
    "tool.execute.before": async (input, output) => {
      // Block file edits if workflow state < PLAN
      // Block commits if workflow state < COMPLETE
      // Log tool calls to current initiative
    },

    // Track workflow progress
    "tool.execute.after": async (input, output) => {
      // Update initiative progress log after each step
    },

    // Permission integration
    "permission.ask": async (input) => {
      // Auto-allow tool calls that align with current workflow step
    },

    // Event bus for observability
    "event": (input) => {
      // Log significant events to initiative
    },

    // Custom tools
    tool: {
      mdocs_init: {
        description: "Initialize /mdocs folder structure",
        handler: async () => mdocs.init()
      },
      mdocs_status: {
        description: "Show current workflow state and active initiatives",
        handler: async () => workflow.status()
      }
    }
  }
}) satisfies Plugin
```

## Skills

### mdocs-workflow

- **Triggers:** "start work", "new task", "begin initiative", "work on"
- **Content:** Full 9-step workflow guide, how to read/write initiatives, how to query wiki, how to hand off to subagents

### mdocs-initiative

- **Triggers:** "create initiative", "update initiative", "initiative status"
- **Content:** Initiative file format, naming convention, status transitions, how to link wiki entries, how to generate INDEX.md

## Agent: mdocs-orchestrator

```yaml
---
description: Orchestrates work using the mdocs initiative/wiki workflow.
mode: primary
model: anthropic/claude-sonnet-4-6
---
You are a workflow orchestrator. When given a task:
1. Understand the request (ask questions if unclear)
2. Check /mdocs/initiatives/ for related work
3. Read context from initiative + wiki
4. Create a plan
5. Dispatch subagents with assembled context
6. Verify results
7. Report to wiki, update initiative
8. Offer to commit
```

## Subagent Integration

The plugin assembles context for Task tool handoffs:

```ts
async function assembleContext(initiative, wikiEntries) {
  return {
    initiative: readInitiative(initiative),
    wikiContext: wikiEntries.map(e => readWikiEntry(e)),
    currentStep: workflow.getCurrentStep(),
    constraints: getConstraintsForStep(workflow.getCurrentStep())
  }
}
```

Subagent prompts include:
- Initiative objective and plan
- Relevant wiki entries
- Current step constraints
- Verification criteria

## Installation

```bash
npm install -g opencode-mdocs
```

### opencode.json

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-mdocs"],
  "skills": {
    "paths": ["node_modules/opencode-mdocs/skills"]
  },
  "agent": {
    "mdocs-orchestrator": "node_modules/opencode-mdocs/agents/mdocs-orchestrator.md"
  }
}
```

## Bootstrap Behavior

First time the plugin loads, if `/mdocs` doesn't exist:
1. Create `/mdocs/initiatives/` and `/mdocs/wiki/` directories
2. Create `/mdocs/initiatives/INDEX.md` and `/mdocs/wiki/INDEX.md`
3. Create first initiative: `install-and-configure-opencode-mdocs--<today>.md`
4. This initiative tracks the plugin's own installation (self-referential / dogfooding)

## Self-Referential Design

The plugin's own development is tracked as an initiative. The wiki documents:
- How the plugin works (architecture decisions)
- How to contribute (development runbooks)
- Why certain design choices were made

This proves the system works and serves as living documentation.

## Referenced By

*Auto-generated by mdocs*

- install-mdocs
- align-implementation-with-philosophy
- fix-local-dogfooding-agent-discovery
- fix-v1-opencode-compatibility
- evaluate-pr-3-wiki-orphan-fix
- fix-wiki-index-consistency-check
- fix-opencode-runtime-tool-registration
- prepare-v1-3-0-release
- fix-v1-3-0-agent-discovery-regression
