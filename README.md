# harness-mdocs

Surface-neutral initiative and wiki memory for AI coding harnesses.

`harness-mdocs` packages the shared mdocs core plus adapters for host tools such as OpenCode, Codex, and Claude Code. The core owns durable initiative files, wiki entries, workflow state, validation, search, audit logging, and command behavior. Surfaces translate that core into the capabilities each host can actually provide.

| Surface | Command access | Workflow enforcement | Audit | Subagent dispatch |
| --- | --- | --- | --- | --- |
| OpenCode | native custom tools | enforced (hooks) | enforced (hooks) | native |
| Claude Code | MCP tools (+ CLI fallback) | enforced (PreToolUse hook) | enforced (PostToolUse hook) | native (`Task`) |
| Codex v1 | `mdocs` CLI | advisory (instructions) | command-level | prompted |

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

The package publishes a `mdocs` binary. When installed as a project dependency,
run it through the package manager unless `node_modules/.bin` is already on
your shell `PATH`:

```bash
npm exec -- mdocs status
./node_modules/.bin/mdocs status
```

For personal terminal use across projects, a global install also exposes
`mdocs` on the shell `PATH`:

```bash
npm install -g harness-mdocs
mdocs status
```

Installing `harness-mdocs` as an OpenCode plugin is separate from shell command
installation. OpenCode can load plugin hooks and custom tools from its package
cache without making `mdocs` available in your terminal or in another harness.
Use a project dependency, global install, or a repo-local shim when a surface
expects to run `mdocs` as a command.

## OpenCode Usage

For OpenCode, load the package root from `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["harness-mdocs@0.4.0"]
}
```

Pinning the exact npm version is recommended for project configs. OpenCode
installs npm plugins into `~/.cache/opencode/packages/` at startup, and a
previous `harness-mdocs@latest` cache can remain stale across restarts. To
upgrade later, change the pinned version (for example, `harness-mdocs@0.5.0`)
and restart OpenCode.

If migrating from an older `harness-mdocs@latest` or `opencode-mdocs` config,
remove stale cached packages before restarting:

```bash
rm -rf ~/.cache/opencode/packages/harness-mdocs@latest
rm -rf ~/.cache/opencode/packages/opencode-mdocs@*
```

Verify the cached plugin version after restart:

```bash
node -p "require(process.env.HOME + '/.cache/opencode/packages/harness-mdocs@0.4.0/node_modules/harness-mdocs/package.json').version"
```

The command should print `0.4.0`.

You can also use the explicit OpenCode surface when you do not need a pinned
npm version:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["harness-mdocs/opencode"]
}
```

For pinned installs, prefer the package root (`harness-mdocs@0.4.0`). It loads
the OpenCode surface by default.

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

Codex plugin installation makes the skills available to Codex, but it does not
install the `mdocs` shell command by itself. Start Codex from an environment
where one of the supported CLI paths works:

```bash
npm exec -- mdocs status
./node_modules/.bin/mdocs status
mdocs status
```

When dogfooding this package repo from a fresh Codex thread, keep the
repo-local shim on `PATH`. The shim lives in `harness-mdocs/.agents/bin/mdocs`,
runs `node dist/cli/index.js`, and requires a fresh `npm run build`:

```bash
PATH="$PWD/.agents/bin:$PATH" mdocs status
```

Codex v1 limitations are intentional and should be described honestly:

- workflow gates are advisory instructions, not host-level enforcement
- Codex v1 does not block write or destructive commands through mdocs
- Codex v1 does not automatically audit every host tool call
- command access is through the `mdocs` CLI, not native Codex command tools or MCP tools

## Claude Code Usage

Claude Code is a Tier 3 surface — full host-level enforcement, on par with OpenCode. It integrates through an MCP server, PreToolUse/PostToolUse hooks, skills, and CLAUDE.md instructions.

### Plugin install (recommended)

Install from the bundled marketplace with two commands:

```
/plugin marketplace add <owner>/harness-mdocs
/plugin install mdocs@harness-mdocs
```

This registers the MCP server, hooks, skills, and orchestrator agent automatically — no manual `.claude/settings.json` editing required.

The plugin bundles the compiled `dist/` and a standalone MCP server so no separate `npm install` is needed at runtime. Hooks use direct `node` paths (not `npx`) for fast per-tool-call execution.

To update:

```
/plugin marketplace update harness-mdocs
```

### Manual install (fallback)

Claude Code reads project-scoped MCP servers from `.mcp.json` (repo root) and
hooks from `.claude/settings.json` — they are **two separate files**. Templates
ship in the package under `src/surfaces/claude-code/assets/templates/`.

Create `.mcp.json` at the project root (`mcp.json` template):

```json
{
  "mcpServers": {
    "mdocs": {
      "command": "node",
      "args": ["${workspaceFolder}/node_modules/harness-mdocs/dist/cli/index.js", "mcp"],
      "env": { "MDOCS_PROJECT_DIR": "${workspaceFolder}" }
    }
  }
}
```

Add the hooks to `.claude/settings.json` (`settings-patch.json` template):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|Bash", "hooks": [
        { "type": "command", "command": "node ${workspaceFolder}/node_modules/harness-mdocs/dist/cli/hooks/pre-tool-use.js" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit|Bash|Task|Agent", "hooks": [
        { "type": "command", "command": "node ${workspaceFolder}/node_modules/harness-mdocs/dist/cli/hooks/post-tool-use.js" } ] }
    ]
  }
}
```

Then add the CLAUDE.md snippet (also in `assets/templates/`) and copy the three skills from `assets/skills/` into your `.claude/skills/`. Restart Claude Code so both the MCP server and hooks load.

What the Claude Code surface provides:

- **MCP server** (`mdocs mcp`) exposing all mdocs commands as tools: the aggregate `mdocs` tool plus `mdocs_init`, `mdocs_status`, `mdocs_validate`, `mdocs_search`, `mdocs_lookup`, `mdocs_dispatch`, `mdocs_audit`, `mdocs_index_check`, `mdocs_resume`, `mdocs_reset`.
- **SessionStart hook** that injects a compact mdocs orientation banner (initiative counts by status, the active initiative id/title + workflow step, wiki page count, and a pointer to `mdocs_status`) at the start of every fresh or resumed session. The hook fails open — a hook error never wedges the session. A matching **PreCompact hook** re-emits the banner so orientation survives compaction.
- **PreToolUse hook** that blocks `Write`/`Edit` before the `PLAN` step (edits under `./mdocs/` are always allowed). `Bash` is audited but not gated by content. The hook fails open — a hook error never wedges your session.
- **PostToolUse hook** that records audit events, serialized under a lock so Claude Code's parallel tool execution does not lose updates.
- **Skills** (`mdocs-workflow`, `mdocs-initiative`, `mdocs-orchestrator`) and a native subagent (`Task`/`Agent`) orchestrator prompt.

For guidance on layering workspace-specific conventions over harness-mdocs (sibling knowledge bases, external task lists, consumer SessionStart hooks, and CLAUDE.md composition), see [docs/consumer-layering.md](docs/consumer-layering.md).

## Enforcement

Workflow enforcement blocks `Write`/`Edit` before the `PLAN` step and allows them from `PLAN` through `COMPLETE`. `Bash` is audited but not gated by content. Edits under `./mdocs/` are always allowed.

**Configuration:**
- Enforcement mode: `gate` (default) | `advisory` | `off`. Env: `MDOCS_ENFORCEMENT`. `off` = CI escape hatch.
- IDLE strictness: `mdocs.enforcement.idle` = `open` (default; IDLE unconstrained) | `readonly` (IDLE = read tools + `./mdocs/` only). Env: `MDOCS_ENFORCEMENT_IDLE`.
- Config precedence: env > `.mdocs.json` file > detected contract.
- Reset: `mdocs_reset` command → IDLE, clears active initiative. `resume()` auto-starts fresh cycles when prior initiative reached `COMPLETE` or at `IDLE`, landing at `UNDERSTAND`.

The engine treats `PLAN`/`EXECUTE`/`VERIFY`/`REPORT`/`COMPLETE` as one "edits allowed" band — it does not enforce plan-vs-execute discipline.

Notes:

- Hook commands must use a direct `node` path, not `npx` — `npx` cold-start runs on every tool call and is too slow for the hook hot path. The MCP server (spawned once per session) may use `npx`.
- **Project root resolution** — the MCP server and the PreToolUse / PostToolUse hooks all resolve the project root through one shared helper (`resolveProjectRoot` in `src/core/project-root.ts`), so the gate and MCP always operate on the same mdocs root even when `cwd` and `MDOCS_PROJECT_DIR` disagree. Precedence:
  1. `MDOCS_PROJECT_DIR` env var if set and points at an existing directory (explicit pin — honored even before `mdocs/` is bootstrapped, so the `set env → mdocs init` flow roots at the pinned dir);
  2. else the nearest ancestor (walking up from `cwd`, inclusive) that contains a `mdocs/` dir;
  3. else the effective `cwd` itself (preserves `process.cwd()` behavior).
- Multi-project switching within one session is not supported — a session resolves a single root. Run separate sessions (or restart the MCP server after `cd`) to switch projects.

## Consumer Schema Compatibility

Some consumer workspaces use a thinner schema than harness-mdocs authors by default: a metadata-only initiative `_status.md` (lifecycle frontmatter + prose, artifacts in sibling files) and wiki pages with path-style `id` (`systems/foo`), singular `category` (`system`), and a hyphenated `expected-duration`. harness-mdocs honors these **without any consumer data migration** — every behavior is opt-in via a `.mdocs.json` config file in the mdocs root, and the defaults reproduce today's behavior exactly.

`.mdocs.json` (recognized keys: `compatibility`, `standaloneCategories`, `mdocsDirName`):

```json
{
  "compatibility": {
    "initiativeRecordMode": "metadata-only",
    "enforcementMode": "advisory"
  },
  "standaloneCategories": ["repos", "systems", "glossary"]
}
```

- `initiativeRecordMode: "metadata-only"` — treat `_status.md` as thin lifecycle metadata: rewrite only lifecycle keys (status/updated/completed/graduated) in place, never inject `## Objective`/`## Plan`/`## Progress Log`, never add structural frontmatter keys, preserve inline `tags: [a, b]` formatting. PostToolUse records audit only (no progress-log mutation). The linter relaxes initiative body-section and required-field checks while keeping lifecycle telemetry.
- Wiki identity resolves by filename stem + parent-directory category, so path-style `id` and singular `category` produce correct backlinks; `appendLog` can emit the consumer heading `## [YYYY-MM-DD] {operation} | {subject}`.

Config precedence: env > `.mdocs.json` file > detected contract. See [docs/consumer-layering.md](docs/consumer-layering.md).

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
- `harness-mdocs/claude-code` - Claude Code surface: MCP server, hooks, translation, capability declaration.
- `mdocs` - CLI command for surfaces that do not expose native tools.
- `mdocs mcp` - starts the Claude Code MCP server over stdio.

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
expected_duration: normal
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

Status values are `active`, `paused`, and `done` in flat-v1 projects. Contract-aware reads also accept directory-v2 `_status.md` initiatives and normalize `complete` to `done`. Directory-v2 projects support native `_status.md` writes for initiative create, update, done, delete, archive, and wiki links without creating flat initiative files.

### Initiative lifecycle

**Completion states:** `complete` is the surfaced completion state for directory-v2 initiatives (dir-v2 `markDone` writes `complete`). `done` remains the flat-v1 alias. Both mean "completed" — `isCompleted()` treats them equally for archive, lint, blocking, and overdue checks.

**Expected duration:** The optional `expected_duration` field (`'normal' | 'long' | 'suppress'` in frontmatter) drives the `long-running-active` lint rule. `normal` warns if active > 14 days, `long` > 60 days, `suppress` never warns. This helps distinguish quick tasks from long-running research without false positives.

**Graduation:** The `lifecycle.graduate` command records a completed initiative's learning into `wiki/overview.md` (as named H2 sections) and `wiki/log.md` (append-only entries). It stamps the initiative `graduated` and clears the `graduation-due` lint rule. Only caller-supplied text is written — no auto-generation. Example:

```bash
mdocs command lifecycle.graduate --json '{
  "id": "add-authentication",
  "sections": [
    {"section": "Authentication", "body": "JWT-based auth with refresh tokens."}
  ],
  "logEntry": "Implemented JWT auth flow; see overview."
}'
```

**Lint rules:** Three advisory lint rules (zero score impact) track initiative health: `long-running-active` (active initiative exceeds expected duration), `stale-complete` (completed > 30 days, not archived), and `graduation-due` (completed > 7 days, not graduated).

## Wiki

Wiki entries are durable Markdown notes in `mdocs/wiki/<category>/`. Contract-aware reads and writes also treat root wiki pages such as `mdocs/wiki/index.md`, `overview.md`, `log.md`, and `glossary.md` as first-class entries without generating or overwriting lowercase canonical indexes. Root wiki commands use an omitted or empty category (`wiki.create` with `id` and `title`, no `category`). `wiki.link` accepts both `category/id` and root `id` references.

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

For directory-v2 repositories, stable wiki pages can record provenance with `source_initiatives` or `sources`; these satisfy completed-initiative learning gates without requiring the initiative to own a `related_wiki` link.

`mdocs/_obsidian/` is treated only as an optional human-facing visibility/export layer. It is detected for compatibility metadata but is never scanned as canonical initiatives or wiki knowledge. Optional refresh commands can be passed through compatibility config as `obsidianRefreshCommand`; harness-mdocs does not auto-run shell refreshes during read, search, or validation.

## CLI

The `mdocs` CLI is the portable command surface. It is especially important for Codex v1 and other hosts that do not expose native mdocs tools.

CLI availability depends on how the package is installed:

- Project dependency: use `npm exec -- mdocs <command>` or
  `./node_modules/.bin/mdocs <command>`.
- Global install: use `mdocs <command>` directly.
- Package repo dogfooding: from `harness-mdocs`, run `npm run build`, then use
  `PATH="$PWD/.agents/bin:$PATH" mdocs <command>`.
- OpenCode plugin install: use OpenCode custom tools inside OpenCode; install
  the npm package separately if you also need a shell `mdocs` command.

Common commands:

```bash
mdocs init
mdocs status
mdocs resume [initiative-id]
mdocs lookup <query>
mdocs search <query>
mdocs dispatch [initiative-id]
mdocs step <step>
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
│   ├── cli/                  # portable mdocs CLI (+ hooks/ for Claude Code)
│   ├── core/                 # surface-neutral managers, workflow, shared operations
│   └── surfaces/
│       ├── codex/            # Codex v1 metadata and packaging
│       ├── claude-code/      # MCP server, hooks, translation, assets
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
npm run lint
npm test
npm run test:codex
npm run test:opencode
npm run test:claude-code
npm run coverage
npm run mdocs:lint
npm run quality
npm run release:check
```

Local quality tooling stays lightweight: `lint` is TypeScript typechecking, `coverage` emits text and lcov reports, and `mdocs:lint` validates initiative/wiki graph health through the built CLI. `release:check` adds the package dry run, which invokes npm lifecycle scripts and may refresh generated plugin assets. Complexity analysis is intentionally deferred until the project needs a dedicated lint layer.

GitHub Actions mirrors the local gates in two phases: PRs into `staging` and pushes to `staging` run `npm run quality`; pushes to `main` and `v*` tags run `npm run release:check` in the `release` environment as a pre-publish check only. Publishing is intentionally separate from this CI phase.

Before publishing:

```bash
npm run release:check
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
