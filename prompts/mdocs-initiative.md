# Mdocs Initiative

Initiatives live in `./mdocs/initiatives/` and represent durable units of work.

Use a dated filename with the initiative id stem: `<id>--<YYYY-MM-DD>.md`.

Required frontmatter:

```yaml
id: add-authentication
title: Add Authentication
status: active
created: 2026-06-05
updated: 2026-06-05
owner: agent
tags: []
related_wiki: []
```

Optional v2 metadata:

- `phase`
- `handoff_summary`
- `open_questions`
- `blockers`
- `next_action`

Required sections:

- Objective
- Plan
- Progress Log
- Artifacts

Keep `updated`, progress, blockers, and next action current so another agent can resume the work.
