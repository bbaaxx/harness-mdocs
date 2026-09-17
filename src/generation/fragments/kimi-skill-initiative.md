---
name: mdocs-initiative
description: Use when creating, updating, or querying mdocs initiatives in Kimi Code sessions.
whenToUse: Creating or updating initiatives, linking wiki learnings, or querying initiative state
---

# Mdocs Initiative Management For Kimi Code

Initiatives live in `./mdocs/initiatives/`. Filename format: `<id-slug>--<YYYY-MM-DD>.md`.

Prefer the MCP `mdocs` aggregate tool (`mcp__mdocs__mdocs` with `command` + `args`). Fall back to the `mdocs` CLI via Bash. Last resort: edit files directly, then run `mdocs_validate`.

## Frontmatter schema

```yaml
id: add-authentication
title: Add authentication
status: active
created: 2026-06-05
updated: 2026-06-05
owner: agent
tags: [auth]
related_wiki: [architecture/auth-flow]
phase: implementation
handoff_summary: "Login form implemented; token storage still under review."
open_questions: ["Should sessions support SSO?"]
blockers: ["Waiting on OAuth client id"]
next_action: "Write integration tests."
```

Status values: `active`, `paused`, `done`.

Optional v2 metadata fields:

- `phase`: discovery, planning, implementation, verification, or done
- `handoff_summary`: short summary for a fresh agent or subagent
- `open_questions`: unresolved questions
- `blockers`: current blockers
- `next_action`: recommended next step

Required sections: Objective, Plan, Progress Log, Artifacts.

## MCP tool usage

Create:

```
mcp__mdocs__mdocs  { "command": "initiative.create",
  "args": { "title": "Add authentication", "id": "add-authentication",
            "objective": "Implement login", "plan": ["Inspect","Implement","Verify"] } }
```

Update (metadata under `updates`, `progressNote` stays top-level):

```
mcp__mdocs__mdocs  { "command": "initiative.update",
  "args": { "id": "add-authentication",
            "updates": { "phase": "implementation", "nextAction": "Run tests" },
            "progressNote": "Implemented login form" } }
```

Link durable knowledge:

```
mcp__mdocs__mdocs  { "command": "wiki.stub",   "args": { "category": "architecture", "id": "auth-flow", "title": "Auth Flow" } }
mcp__mdocs__mdocs  { "command": "wiki.create", "args": { "category": "architecture", "id": "auth-flow", "title": "Auth Flow",
            "content": "Token exchange and session lifecycle.",
            "relatedInitiatives": ["add-authentication"], "lifecycle": "stable" } }
```

Resolve an initiative by id/title/slug with `mcp__mdocs__mdocs_lookup`; resume with `mcp__mdocs__mdocs_resume`.

`wiki.update` takes changed fields at the top level after `category` and `id` — do NOT wrap wiki fields in `updates`.

## Completion gate

When marking an initiative done: run verification first, update progress, and ensure at least one **stable** wiki learning exists for the initiative when the work produced reusable project knowledge. Then `initiative.done`.
