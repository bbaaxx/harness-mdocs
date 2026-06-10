# harness-mdocs

Surface-neutral initiative and wiki memory for AI coding harnesses.

`harness-mdocs` packages the shared mdocs core plus adapters for host tools such as OpenCode and Codex. The core owns durable initiative files, wiki entries, workflow state, validation, search, audit logging, and command behavior. Surfaces translate that core into the capabilities each host can actually provide.

## What It Does

mdocs brings durable structure to AI-assisted development:

1. **Tracks work as initiatives** - persistent task files with objective, plan, progress, blockers, and handoff state.
2. **Builds a project wiki** - stable knowledge that survives thread restarts and can be linked back to initiatives.
3. **Shares one memory model across harnesses** - OpenCode, Codex, and future surfaces use the same file formats and command registry.
4. **Validates the graph** - checks initiatives, wiki entries, backlinks, completion gates, and stable learning requirements.
5. **Assembles handoff context** - combines initiative state, related wiki, search-ranked memory, and recent audit events for subagents or new sessions.

## Philosophy

AI agents working in different terminals, desktop apps, or harnesses should not have to rediscover the same project context. mdocs treats those sessions as different focal points over one shared memory system.

The package keeps two layers of memory:

- **Initiatives** hold active collaboration state: goals, plans, progress logs, blockers, next actions, and artifacts.
- **Wiki** holds durable knowledge: architecture, decisions, how-tos, testing notes, release learnings, and other reusable context.

Both layers are plain Markdown with frontmatter, so agents can maintain them and humans can review them.

## Installation

```bash
npm install --save-dev harness-mdocs
```

Node.js 18 or newer is required.

## OpenCode Usage

For OpenCode, load the package root from `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["harness-mdocs"]
}
```

You can also use the explicit OpenCode surface:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["harness-mdocs/opencode"]
}
```

Restart OpenCode after changing plugin config. OpenCode loads plugin config at startup.

The OpenCode surface preserves the legacy `opencode-mdocs` behavior:

- registers the `mdocs-orchestrator` agent
- registers bundled workflow and initiative skills
- initializes `./mdocs` on first run
- exposes mdocs custom tools
- enforces workflow gates through OpenCode hooks
- records audit and progress events through hook integration

## Codex Usage

Codex v1 uses the bundled Codex plugin metadata and skills, but command execution is CLI-backed:

```bash
mdocs status
mdocs resume
mdocs validate
mdocs command --help
```

When dogfooding this repo from a fresh Codex thread, keep the repo-local shim on `PATH`:

```bash
PATH="$PWD/.agents/bin:$PATH" mdocs status
```

Codex v1 limitations are intentional and should be described honestly:

- workflow gates are advisory instructions, not host-level enforcement
- Codex v1 does not block write or destructive commands through mdocs
- Codex v1 does not automatically audit every host tool call
- command access is through the `mdocs` CLI, not native Codex command tools or MCP tools

## First Run

On first initialization, mdocs creates a project-local memory directory:

```text
mdocs/
├── initiatives/
│   └── INDEX.md
└── wiki/
    └── INDEX.md
```

OpenCode initializes this automatically through its config hook. Other surfaces can initialize with:

```bash
mdocs init
```

## Entry Points

- `harness-mdocs` - default OpenCode plugin entrypoint.
- `harness-mdocs/opencode` - explicit OpenCode surface entrypoint.
- `harness-mdocs/plugin` - compatibility alias mirroring the legacy `opencode-mdocs/plugin` shape.
- `harness-mdocs/api` - public API helpers for programmatic consumers.
- `harness-mdocs/core` - surface-neutral managers, workflow, command registry, validation, search, audit, and dispatch.
- `harness-mdocs/codex` - Codex v1 surface metadata and plugin packaging.
- `mdocs` - CLI command for surfaces that do not expose native tools.

Programmatic API consumers can import from the API subpath:

```ts
import { createMdocsCore } from 'harness-mdocs/core';
```

## Migrating From opencode-mdocs

`harness-mdocs` is the primary package going forward. New installs do not need `opencode-mdocs` installed beside it.

For an existing OpenCode project:

1. Replace `opencode-mdocs` with `harness-mdocs`.
2. Update `opencode.json` to use `harness-mdocs` or `harness-mdocs/opencode`.
3. Restart OpenCode.
4. Verify that the mdocs tools, `mdocs-orchestrator` agent, bundled skills, and existing `./mdocs` data load correctly.

See [docs/packaging-strategy.md](docs/packaging-strategy.md) for the release and migration checklist.

## Workflow

The mdocs workflow is:

```text
IDLE -> UNDERSTAND -> DISCOVER -> CONTEXT -> PLAN -> EXECUTE -> VERIFY -> REPORT -> COMPLETE
```

| Step | Purpose |
| --- | --- |
| `IDLE` | No active task, or waiting for the next request. |
| `UNDERSTAND` | Clarify the request and success criteria. |
| `DISCOVER` | Look for related initiatives or wiki knowledge. |
| `CONTEXT` | Read the active initiative and linked wiki entries. |
| `PLAN` | Record the implementation plan. |
| `EXECUTE` | Make the change or dispatch focused work. |
| `VERIFY` | Run checks and inspect results. |
| `REPORT` | Update progress, artifacts, and durable wiki learning. |
| `COMPLETE` | Mark the initiative done after verification. |

OpenCode can enforce parts of this workflow through hooks. Codex v1 follows it through skill instructions and CLI-backed state.

## Initiatives

Initiatives are persistent task files in `mdocs/initiatives/`.

Filename format:

```text
<slug>--<YYYY-MM-DD>.md
```

Example:

```markdown
---
id: add-authentication
title: Add authentication
status: active
created: 2026-06-10
updated: 2026-06-10
tags: [auth, api]
related_wiki: [architecture/auth-flow]
phase: implementation
next_action: Run integration tests.
---

## Objective
Add JWT-based authentication to the API.

## Plan
- [ ] Choose token library
- [/] Implement middleware
- [x] Document auth flow

## Progress Log
- [2026-06-10T12:00:00Z] Created initiative

## Artifacts
- src/auth.ts
```

Status values are `active`, `paused`, and `done`.

## Wiki

Wiki entries are durable Markdown notes in `mdocs/wiki/<category>/`.

Example:

```markdown
---
id: auth-flow
title: Auth Flow
category: architecture
created: 2026-06-10
updated: 2026-06-10
related_initiatives: [add-authentication]
tags: [auth, architecture]
lifecycle: stable
knowledge_type: architecture
confidence: high
source_initiatives: [add-authentication]
---

Token exchange and session lifecycle details.
```

Stable wiki learning matters for completed initiatives. `mdocs validate` warns when a done initiative has no linked stable learning.

## CLI

The `mdocs` CLI is the portable command surface. It is especially important for Codex v1 and other hosts that do not expose native mdocs tools.

Common commands:

```bash
mdocs init
mdocs status
mdocs resume [initiative-id]
mdocs lookup <query>
mdocs search <query>
mdocs dispatch [initiative-id]
mdocs validate
mdocs index check
mdocs index repair
mdocs command --help
```

Aggregate commands use JSON payloads:

```bash
mdocs command initiative.create --json '{"id":"add-auth","title":"Add Auth","objective":"Implement login","plan":["Inspect","Implement","Verify"]}'
mdocs command initiative.update --json '{"id":"add-auth","updates":{"phase":"implementation","nextAction":"Run tests"},"progressNote":"Implemented login form"}'
mdocs command wiki.create --json '{"category":"testing","id":"cli-help","title":"CLI Help","content":"Payload examples.","relatedInitiatives":["add-auth"]}'
mdocs command wiki.update --json '{"category":"testing","id":"cli-help","content":"Updated learning.","lifecycle":"stable","sourceInitiatives":["add-auth"]}'
mdocs command initiative.done --json '{"id":"add-auth"}'
```

`initiative.update` supports metadata changes under an `updates` object. `wiki.update` uses changed fields at the top level after `category` and `id`; do not wrap wiki fields in `updates`.

## OpenCode Custom Tools

When loaded in OpenCode, the plugin exposes custom tools backed by the same core:

- `mdocs` - aggregate command execution
- `mdocs_init` - initialize `./mdocs`
- `mdocs_status` - show workflow state
- `mdocs_search` - search initiatives and wiki
- `mdocs_lookup` - resolve an initiative by id, title, slug, or filename
- `mdocs_dispatch` - assemble handoff context
- `mdocs_audit` - query audit events
- `mdocs_resume` - resume active or named work
- `mdocs_validate` - validate memory integrity
- `mdocs_index_check` - check or repair generated indices

## Architecture

```text
harness-mdocs/
├── src/
│   ├── cli/                  # portable mdocs CLI
│   ├── core/                 # surface-neutral managers and workflow
│   └── surfaces/
│       ├── codex/            # Codex v1 metadata and packaging
│       └── opencode/         # OpenCode adapter, hooks, tools
├── agents/                   # OpenCode agent asset
├── prompts/                  # prompt assets
├── skills/                   # bundled skills
├── docs/                     # packaging and surface notes
└── mdocs/                    # this repo's dogfooded memory
```

The core command registry is the behavioral center for initiative and wiki mutations. Surfaces should call the core rather than reimplementing command semantics.

## Development

```bash
npm install
npm run build
npm test
npm run test:codex
npm run test:opencode
```

Before publishing:

```bash
npm run build
npm test -- --runInBand
npm --cache .npm-cache pack --dry-run
```

Do not publish from an unverified tree. Inspect the dry-run package for `dist`, `agents`, `skills`, `prompts`, `docs`, `README.md`, and `LICENSE`.

## Notes

- Generated indices live under `mdocs/initiatives/INDEX.md`, `mdocs/wiki/INDEX.md`, and per-category wiki `INDEX.md` files.
- Runtime workflow state is stored in `mdocs/.workflow-state.json`.
- Index metadata is stored in `mdocs/.index-meta.json`.
- Audit logs use NDJSON and rotate automatically.
- The memory files are intentionally human-readable and reviewable.

## License

MIT
