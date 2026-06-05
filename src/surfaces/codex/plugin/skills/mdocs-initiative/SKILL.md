---
name: mdocs-initiative
description: Use when creating, updating, or querying initiatives in Codex sessions.
---

# Mdocs Initiative Management For Codex

Initiatives live in `./mdocs/initiatives/`.

Filename format: `<id-slug>--<YYYY-MM-DD>.md`.

Frontmatter schema:

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
- `handoff_summary`: short summary for a fresh agent
- `open_questions`: unresolved questions
- `blockers`: current blockers
- `next_action`: recommended next step

Required sections:

- Objective
- Plan
- Progress Log
- Artifacts

CLI examples:

```bash
mdocs command initiative.create --json '{"title":"Add authentication","id":"add-authentication"}'
mdocs command initiative.update --json '{"id":"add-authentication","progressNote":"Implemented login form"}'
mdocs command wiki.stub --json '{"category":"architecture","id":"auth-flow","title":"Auth Flow"}'
```

When marking an initiative done, run verification first, update progress, and link durable wiki knowledge when the work created reusable project knowledge.
