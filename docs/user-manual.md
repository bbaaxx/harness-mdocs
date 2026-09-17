# harness-mdocs 2.1.0 — User Manual

Surface-neutral initiative and wiki memory for AI coding harnesses.

This manual covers installing and operating `harness-mdocs` 2.1.0 (the npm
package name; the `mdocs` name refers to the memory system and CLI). Every
behavior described here ships in 2.1.0 — nothing aspirational.

---

## 1. What mdocs is

mdocs keeps two layers of project memory, both stored as **plain Markdown with
YAML frontmatter** so agents can maintain them and humans can review them in
any editor or diff tool:

- **Initiatives** — active work state. Persistent task files in
  `mdocs/initiatives/` holding objective, plan checklist, progress log,
  blockers, next action, and handoff artifacts. An initiative answers: *what
  are we doing right now and where did we stop?*
- **Wiki** — durable knowledge. Markdown notes in `mdocs/wiki/<category>/`
  (architecture, decisions, how-tos, testing notes, release learnings) that
  survive thread restarts and can be linked back to initiatives. The wiki
  answers: *what do we know about this project that should not be
  rediscovered?*

The two layers are linked: initiatives reference wiki pages via
`related_wiki`, wiki pages reference initiatives via `related_initiatives`,
and `mdocs validate` warns when a completed initiative produced no linked
stable learning.

Example initiative (`mdocs/initiatives/<slug>--<YYYY-MM-DD>.md`):

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
```

Example wiki page (`mdocs/wiki/architecture/auth-flow.md`):

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
---

Token exchange and session lifecycle details.
```

Supporting runtime files:

- `mdocs/.workflow-state.json` — runtime workflow state.
- `mdocs/.index-meta.json` — index metadata.
- `mdocs/initiatives/INDEX.md`, `mdocs/wiki/INDEX.md`, per-category
  `INDEX.md` — generated indices (rebuild with `mdocs index repair`).
- Audit logs — NDJSON, rotated automatically.

---

## 2. Installation

Base requirement for every surface: Node.js 18 or newer.

```bash
npm install --save-dev harness-mdocs
```

> **Restart caveat (all plugin surfaces).** Installing into a *running*
> session does not retroactively register tools, hooks, or the SessionStart
> banner — hosts load plugin configuration at startup. After installing or
> changing plugin configuration, **restart the host / start a fresh session**.
> Missing `mdocs_*` tools before the restart is expected, not a bug.

### 2.1 OpenCode

Load the package root from `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["harness-mdocs@2.1.0"]
}
```

Pin the exact npm version. OpenCode installs npm plugins into
`~/.cache/opencode/packages/` at startup, and a `@latest` cache can stay
stale across restarts. If migrating from an old cache:

```bash
rm -rf ~/.cache/opencode/packages/harness-mdocs@latest
rm -rf ~/.cache/opencode/packages/opencode-mdocs@*
```

An unpinned explicit surface entry also exists (`"plugin":
["harness-mdocs/opencode"]`); prefer the pinned package root — it loads the
OpenCode surface by default.

The OpenCode surface registers the canonical tool set (`mdocs`, `mdocs_init`,
`mdocs_status`, `mdocs_validate`, `mdocs_search`, `mdocs_lookup`,
`mdocs_dispatch`, `mdocs_ingest`, `mdocs_audit`, `mdocs_index_check`,
`mdocs_resume`, `mdocs_advance`, `mdocs_reset`), the `mdocs-orchestrator`
agent, bundled skills, initializes `./mdocs` on first run, and enforces
workflow gates through hooks.

Note: the OpenCode plugin install is separate from shell CLI installation —
it does not put `mdocs` on your terminal `PATH`. See §4 for CLI access.

### 2.2 Claude Code

**Plugin install (recommended)** — from the bundled marketplace:

```
/plugin marketplace add https://github.com/bbaaxx/harness-mdocs
/plugin install mdocs@harness-mdocs
```

This registers the MCP server, PreToolUse/PostToolUse hooks, skills, and
orchestrator agent automatically. Use the full HTTPS URL in HTTPS-only
environments (shorthand may resolve to SSH). Choose scope intentionally:
`--scope local` for trials/one machine (git-ignored), `--scope project` for
tracked team settings (install on every machine first). Update with
`/plugin marketplace update harness-mdocs`. Restart Claude Code after
install or scope changes.

**Manual install (fallback)** — two separate files at the project root:

`.mcp.json` (MCP server):

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

`.claude/settings.json` (hooks — direct `node` paths, **not** `npx`; `npx`
cold-start is too slow for the per-tool-call hook hot path):

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

Templates ship under `src/surfaces/claude-code/assets/templates/`
(`mcp.json`, `settings-patch.json`, CLAUDE.md snippet); copy the three skills
from `assets/skills/` into `.claude/skills/`. Restart Claude Code so both the
MCP server and the hooks load.

If you need consumer compatibility (§5), create `mdocs/.mdocs.json` before
the first mdocs tool run so metadata-only/advisory behavior is active from
the start.

### 2.3 Codex v1

Codex v1 uses the bundled plugin metadata and skills, but **command execution
is CLI-backed** — Codex reaches mdocs through the `mdocs` shell command, not
native tools or MCP. Plugin installation alone does not install the shell
command; start Codex from an environment where one of these works:

```bash
npm exec -- mdocs status          # project dependency
./node_modules/.bin/mdocs status  # node_modules/.bin
mdocs status                      # global install
```

Codex v1 limitations are intentional:

- Workflow gates are **advisory instructions**, not host-level enforcement.
- Codex v1 does not block write or destructive commands through mdocs.
- Codex v1 does not automatically audit every host tool call.
- Command access is the `mdocs` CLI only.

Run `mdocs validate` before claiming mdocs memory is clean.

### 2.4 pi

pi is a Tier 3 surface with full host-level enforcement, installed as a pi
package:

```bash
pi install npm:harness-mdocs        # global; add -l for project settings
pi -e npm:harness-mdocs             # try without installing, current run only
pi -e ./path/to/harness-mdocs       # local-path / git checkout
```

For a git or local-path checkout, build first — the `pi` manifest in
`package.json` points the extension at the compiled
`./dist/surfaces/pi/extension.js`:

```bash
npm run build
pi -e ./
```

The extension registers the canonical tool set, enforces gates via the
`tool_call` event, audits via `tool_result`, and appends an orientation
banner via `before_agent_start`. pi has no native subagent primitive;
`mdocs_dispatch` returns a context bundle you carry forward manually. Full
guide: `docs/pi-surface.md`.

### 2.5 Kimi Code

Kimi Code is a Tier 3 surface with full host-level enforcement, installed as
a Kimi plugin from the manifest bundled in the package:

```bash
npm install --save-dev harness-mdocs
```

```
/plugins install ./node_modules/harness-mdocs/src/surfaces/kimi-code/plugin
```

Then `/reload` or start a new session. The plugin registers the MCP server
(the canonical 13 tools as `mcp__mdocs__*`), the `PreToolUse`/`PostToolUse`/
`SessionStart` hooks, the three `mdocs-*` skills, and the
`mdocs-orchestrator` agent. Plugin installs are currently **per-user**, not
per-project. Manual wiring (`.kimi-code/mcp.json`, `config.toml` hooks,
skills/agents) is documented in `docs/kimi-code.md`.

---

## 3. Core concepts: the workflow

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

Advance with the `mdocs_advance` tool (or `mdocs step <step>` /
`mdocs command workflow.advance` from the CLI). `mdocs_reset` returns to
`IDLE` and clears the active initiative. `resume()` auto-starts a fresh cycle
at `UNDERSTAND` when the prior initiative reached `COMPLETE` or the workflow
is at `IDLE`.

### Why Write/Edit gating exists

The gate enforces "no edits without a recorded plan":

- `Write`/`Edit` are **blocked before `PLAN`** and allowed from `PLAN`
  through `COMPLETE`.
- The engine treats `PLAN`/`EXECUTE`/`VERIFY`/`REPORT`/`COMPLETE` as one
  "edits allowed" band — it does **not** enforce plan-vs-execute discipline.
- `Bash` is **audited but not gated by content**.
- Edits under `./mdocs/` are **always allowed** (agents must be able to
  maintain memory files at any step).
- Read tools (`read`/`grep`/`find`/`ls`) are always allowed.

If a tool call is blocked, advance the workflow (`mdocs_advance`) instead of
working around the gate. Hooks fail open: a hook error never wedges your
session.

---

## 4. CLI reference

The package publishes a `mdocs` binary (`dist/cli/index.js`). How you invoke
it depends on the install:

```bash
npm exec -- mdocs status          # project dependency
./node_modules/.bin/mdocs status  # node_modules/.bin directly
mdocs status                      # global install (npm install -g harness-mdocs)
```

Top-level commands:

```bash
mdocs --version              # build fingerprint: version + gitSha
mdocs init                   # create mdocs/ structure (idempotent)
mdocs status                 # workflow state, active initiative, validation summary
mdocs resume [initiative-id]
mdocs lookup <query>         # resolve by id, title, slug, or filename
mdocs search <query>
mdocs dispatch [initiative-id]
mdocs step <step>            # advance workflow
mdocs reset                  # IDLE + clear active initiative
mdocs validate               # machine-readable JSON
mdocs validate --human       # summary first: valid=true clean=false errors=0 warnings=N
mdocs index check
mdocs index repair
mdocs command --help         # list aggregate commands
mdocs mcp                    # start the MCP server over stdio (Claude Code)
```

Aggregate commands (`mdocs command <name> --json '<payload>'`) cover the
mutation surface registered in the core command registry:

- `initiative.create` / `initiative.update` / `initiative.done` /
  `initiative.delete` / `initiative.archive`
- `wiki.create` / `wiki.update` / `wiki.delete` / `wiki.list`
  (also `wiki.ingest`, `wiki.stub`, `wiki.link`, `wiki.xref`)
- `workflow.advance` / `workflow.reset`
- `lifecycle.graduate`
- `validate`, `index.sync`

Examples:

```bash
mdocs command initiative.create --json '{"id":"add-auth","title":"Add Auth","objective":"Implement login","plan":["Inspect","Implement","Verify"]}'
mdocs command initiative.update --json '{"id":"add-auth","updates":{"phase":"implementation","nextAction":"Run tests"},"progressNote":"Implemented login form"}'
mdocs command wiki.create --json '{"category":"testing","id":"cli-help","title":"CLI Help","content":"Payload examples.","relatedInitiatives":["add-auth"]}'
mdocs command initiative.done --json '{"id":"add-auth"}'
```

Payload shape notes: `initiative.update` takes metadata changes under an
`updates` object; `wiki.update` takes changed fields at the top level after
`category` and `id` — do **not** wrap wiki fields in `updates`.

`mdocs validate` output: `valid` is the pass/fail field; `clean=false` means
warnings exist but no errors. Use without `--human` for CI-consumable JSON.

---

## 5. Configuration

### `.mdocs.json`

A `.mdocs.json` file **in the mdocs root** tunes behavior. Recognized keys:
`compatibility`, `standaloneCategories`, `mdocsDirName`, `audit`.

```json
{
  "compatibility": {
    "initiativeRecordMode": "metadata-only",
    "enforcementMode": "advisory"
  },
  "standaloneCategories": ["repos", "systems", "glossary"],
  "audit": { "level": "metadata", "maxBytes": 10485760, "maxBackups": 3 }
}
```

- `compatibility.initiativeRecordMode: "metadata-only"` — treat a consumer
  `_status.md` as thin lifecycle metadata: mdocs rewrites only lifecycle keys
  (`status`/`updated`/`completed`/`graduated`) in place, never injects
  `## Objective`/`## Plan`/`## Progress Log` sections, never adds structural
  frontmatter keys, and preserves inline `tags: [a, b]` formatting.
  PostToolUse records audit only (no progress-log mutation). Validation does
  not require `id` or `title`; the directory name supplies identity while
  lifecycle validation remains active.
- `standaloneCategories` — wiki categories treated as standalone (no
  generated canonical index).
- `mdocsDirName` — override the `mdocs` directory name.
- `audit.level` (`full` | `metadata` | `off`), `audit.maxBytes`,
  `audit.maxBackups` — audit log volume control. Env overrides:
  `MDOCS_AUDIT_LEVEL`, `MDOCS_AUDIT_MAX_BYTES`, `MDOCS_AUDIT_MAX_BACKUPS`.

Defaults reproduce out-of-the-box behavior exactly; every compatibility
behavior is opt-in and requires **no consumer data migration**.

### Enforcement modes

- `MDOCS_ENFORCEMENT` = `gate` (default) | `advisory` | `off`.
  `gate` blocks Write/Edit before PLAN; `advisory` instructs without
  blocking; `off` is the CI escape hatch.
- IDLE strictness: `mdocs.enforcement.idle` config or
  `MDOCS_ENFORCEMENT_IDLE` env = `open` (default; IDLE unconstrained) |
  `readonly` (IDLE = read tools + `./mdocs/` only).

### Precedence

```text
env vars  >  .mdocs.json file  >  detected contract
```

### Project root resolution

The MCP server, hooks, and CLI all resolve the project root through one
shared helper. Precedence:

1. `MDOCS_PROJECT_DIR` env var, if set and pointing at an existing
   directory (honored even before `mdocs/` is bootstrapped);
2. else the nearest ancestor of `cwd` containing a `mdocs/` directory;
3. else `cwd` itself.

Multi-project switching within one session is not supported — restart the
session (or the MCP server after `cd`) to switch projects.

---

## 6. Upgrade notes: 0.8.x → 2.0.0

Source: `mdocs/wiki/release/v2-0-0-migration-matrix.md` (verified via
`git diff v0.8.1..HEAD` and packed-tarball dogfooding).

**Verdict: zero breaking changes. The release is purely additive.**

- `src/core`, `src/cli`, `src/surfaces`, `src/wiki`, `src/initiatives` —
  byte-identical to 0.8.1.
- Dependencies unchanged (`@modelcontextprotocol/sdk ^1.0.0`, `zod ^4.1.8`).
- `mdocs/` data format unchanged — a legacy v0.8.1-shaped directory
  validates clean under the 2.0.0 build.
- MCP tool surface unchanged — the same 13 tools exist at both tags
  (`mdocs_reset` and `mdocs_advance` were already present in 0.8.1).

New, **opt-in** additions:

- `harness-mdocs/agents` package export — agent contracts, capability
  registry, and the Run controller/trust runtime. A library API for
  programmatic consumers; intentionally not exposed as surface tools.
- Deterministic agent-asset generation (`npm run generate:agents` /
  `npm run check:agents`). Relevant to contributors editing generation
  fragments, not to consumers.

**Migration guide: install 2.0.0, nothing else changes.** Existing `mdocs/`
data, CLI commands, MCP tools, and surface integrations are untouched.

### 2.0.0 → 2.1.0

Also zero breaking changes — purely additive. 2.1.0 adds the **Kimi Code
surface** (`harness-mdocs/kimi-code` export, plugin at
`src/surfaces/kimi-code/plugin`, docs in `docs/kimi-code.md`): the canonical
13 MCP tools, workflow-enforcement hooks, skills, and the orchestrator
agent. Existing surfaces, tools, and `mdocs/` data formats are unchanged.

Migrating from the legacy `opencode-mdocs` package instead: replace it with
`harness-mdocs` in `opencode.json`, restart OpenCode, verify tools and
existing `./mdocs` data load, and remove stale hand-rolled SessionStart /
PreCompact hooks to avoid double banners.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `mdocs_*` tools missing after install | Hosts register plugin tools/hooks at startup; installs do not apply to a running session | Restart the host / start a fresh session |
| `Write`/`Edit` blocked | Workflow step is before `PLAN` (enforcement mode `gate`) | Advance the workflow to `PLAN` (`mdocs_advance` tool or `mdocs step PLAN`); edits under `./mdocs/` are always allowed |
| Gates active in CI | Default `gate` enforcement | Set `MDOCS_ENFORCEMENT=off` (escape hatch) or `advisory` |
| Wrong/stale build behavior | Stale plugin cache or old build | Check the build fingerprint: `mdocs_status` output or `mdocs --version` reports `version` + `gitSha`. For OpenCode, clear `~/.cache/opencode/packages/harness-mdocs@*` and restart |
| Indices out of date | Generated INDEX.md files drifted | `mdocs index check` to report, `mdocs index repair` (or `mdocs command index.sync`) to regenerate |
| Validation failures | Broken links, missing stable learning, lifecycle violations | `mdocs validate --human` for the summary (`valid` is pass/fail; `clean=false` = warnings only); fix reported files and re-run |
| Hook appears not to fire (Claude Code manual install) | MCP server in `.mcp.json` and hooks in `.claude/settings.json` are two separate files; or `npx` used in hook command | Verify both files; use direct `node` paths in hooks, not `npx` |
| MCP/CLI operate on the wrong project | Root resolved from `cwd`, not the intended repo | Set `MDOCS_PROJECT_DIR` to the repo root; restart the session — root switching mid-session is unsupported |
