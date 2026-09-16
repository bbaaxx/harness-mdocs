# Agent Manual — harness-mdocs 2.0.0

Operational reference for AI agents running inside an mdocs session. Covers OpenCode, Claude Code, pi, and Codex-via-CLI. Everything below reflects shipped 2.0.0 source; no aspirational behavior.

---

## 1. Tool Surface (Canonical 13)

Every tool-bearing surface (OpenCode, Claude Code, pi) registers the same canonical tool set. `tests/surfaces/parity.test.ts` (`CANONICAL_TOOL_NAMES`) fails CI if any surface drifts. Codex is excluded by design — it is a CLI+skills surface with no tool registration; it reaches the same capabilities through the `mdocs` CLI.

| Tool | Purpose |
| --- | --- |
| `mdocs` | Aggregate command execution — runs any core registry command via `{ command, args }`. |
| `mdocs_init` | Initialize the `./mdocs/` memory directory (initiatives + wiki indices). |
| `mdocs_status` | Show workflow state: current step, active initiative, build fingerprint (`version` + `gitSha`). |
| `mdocs_validate` | Validate initiative/wiki integrity: schema, graph cross-links, lint rules, completion gates. |
| `mdocs_search` | Keyword search across initiatives and wiki. |
| `mdocs_lookup` | Resolve a single initiative by id, title, slug, or filename. |
| `mdocs_dispatch` | Assemble handoff context (initiative + related wiki + search-ranked memory + recent audit) for a subagent. |
| `mdocs_ingest` | Batch-compose wiki pages + compiled views (`overview.md`/`log.md`) from caller-supplied operations. Never auto-generates prose. |
| `mdocs_audit` | Query the audit log (filter by initiativeId, type, date range, limit). |
| `mdocs_index_check` | Check (`mode: 'check'`) or repair (`mode: 'repair'`) generated INDEX files. |
| `mdocs_resume` | Resume the active or a named initiative; returns next action, blockers, latest progress, validation. |
| `mdocs_advance` | Advance the workflow state machine one step (`{ step: "PLAN" }`). |
| `mdocs_reset` | Return workflow to IDLE and clear the active initiative (full clean slate). |

Codex equivalents are CLI commands: `mdocs status`, `mdocs resume [id]`, `mdocs lookup <query>`, `mdocs search <query>`, `mdocs dispatch [id]`, `mdocs step <step>`, `mdocs validate [--human]`, `mdocs index check|repair`, `mdocs command <name> --json '<args>'`.

---

## 2. The `mdocs` Command Tool — Subcommands

The aggregate `mdocs` tool (and `mdocs command <name> --json` on the CLI) dispatches into the core command registry (`src/core/commands/registry.ts`, `supportedCommands`). Core commands relevant to daily agent operation:

- `initiative.create` — create an initiative file. Requires `title`; optional `id`, `objective`, `plan` (array of strings), `tags`, `relatedWiki`, `expectedDuration`. **Does not activate** — returns a hint: run `mdocs_resume` / `mdocs resume <id>` to activate.
- `initiative.update` — mutate metadata under an `updates` object; append progress via top-level `progressNote`. Supported update fields: `status`, `tags`, `aliases`, `relatedWiki`, `priority`, `dueDate`, `dependsOn`, `owner`, `phase`, `handoffSummary`, `nextAction`, `expectedDuration`, `graduated`, `openQuestions`, `blockers`. Unsupported fields are rejected with no write. Applied fields are verified by re-reading from disk (`appliedFields` / `skippedFields` / `unsupportedFields` in the result). `objective` and `plan` are NOT supported by update.
- `initiative.done` — mark an initiative done after verification. Directory-v2 writes `status: complete`; `done` is the flat-v1 alias — `isCompleted()` treats them equally. Clears active initiative if it was active.
- `initiative.delete` — remove an initiative; regenerates `initiatives/INDEX.md`.
- `initiative.archive` — move a completed initiative to `initiatives/archive/`; regenerates active/archive indices. Rejects non-completed initiatives.
- `wiki.create` — create a wiki entry. Requires `id` and `title`; optional `category` (omit/empty for root wiki pages), `content`, `relatedInitiatives`, `tags`, `lifecycle`, `knowledgeType`, `confidence`, `sourceInitiatives`, `supersedes`, `relatedWiki`.
- `wiki.delete` — remove a wiki entry; regenerates wiki indices.
- `wiki.list` — list wiki entries, optionally filtered by category.
- `validate` — full validation result: initiatives, wiki, graph; top-level `valid`, `errorCount`, `warningCount`, `clean`.
- `index.sync` — force-regenerate initiative and wiki indices after direct file edits.

Additional registry commands you will use: `wiki.update` (changed fields at top level after `category`/`id` — do NOT wrap in `updates`), `wiki.stub` (create placeholder page; `existing: true` if present), `wiki.link` (bidirectional initiative↔wiki link, postcondition-verified), `wiki.xref` (wiki→wiki cross-reference), `wiki.ingest` (batch wiki ops; same engine as `mdocs_ingest`), `workflow.advance`, `workflow.reset`, `lifecycle.graduate` (record a completed initiative's learning into `wiki/overview.md` sections + `wiki/log.md`; stamps `graduated`; never auto-generates prose).

Payload shapes (snake_case inputs are normalized to camelCase):

```
mdocs { command: 'initiative.create', args: { title: 'Add auth', objective: 'Implement login', plan: ['Inspect','Implement','Verify'] } }
mdocs { command: 'initiative.update', args: { id: 'add-auth', updates: { phase: 'implementation', nextAction: 'Run tests' }, progressNote: 'Implemented login form' } }
mdocs { command: 'wiki.create', args: { category: 'architecture', id: 'auth-flow', title: 'Auth Flow', content: '...', relatedInitiatives: ['add-auth'], lifecycle: 'stable' } }
mdocs { command: 'initiative.done', args: { id: 'add-auth' } }
```

---

## 3. Workflow Contract

Steps (`STEPS` in `src/core/workflow/engine.ts`):

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

Gate behavior (`WorkflowEngine.canExecuteTool`):

- **Write/Edit blocked before PLAN**, allowed from PLAN through COMPLETE.
- Engine treats `PLAN`/`EXECUTE`/`VERIFY`/`REPORT`/`COMPLETE` as **one "edits allowed" band** — no plan-vs-execute discipline. That discipline lives in your prompt, not the gate.
- **Bash is audited, not gated by content.** `rm`, `git commit`, `npm publish` are not blocked by the gate. "Don't commit before COMPLETE" is prompt guidance, not enforcement.
- **Edits under `./mdocs/` are always allowed** (path matching covers `filePath`, `path`, `pattern`, and bash command strings).
- Read tools (`read`/`glob`/`grep`/`list`) are always allowed.
- If a tool is blocked, advance the workflow (`mdocs_advance`) rather than working around the gate.

Advance rules: no skipping, no going back. `advance` throws `Cannot go back from X to Y` / `Cannot skip from X to Y`. The state machine does not advance on its own — you drive it.

Enforcement configuration:

- Enforcement mode: `gate` (default) | `advisory` | `off`. Env: `MDOCS_ENFORCEMENT`. `advisory` = writes allowed but every call still audit-logged. `off` = CI escape hatch, no enforcement.
- IDLE strictness: `open` (default; IDLE unconstrained — every tool allowed) | `readonly` (IDLE = read tools + `./mdocs/` paths only; Write/Edit/Bash blocked). Env: `MDOCS_ENFORCEMENT_IDLE`.
- Config precedence: env > `.mdocs.json` file > detected contract.

State lives in `mdocs/.workflow-state.json` (`currentStep`, `activeInitiative`, `stepHistory`).

---

## 4. Lifecycle Semantics

- `mdocs_advance { step }` — moves the state machine exactly one step forward (validated against `STEPS`).
- `mdocs_reset` — returns to `IDLE` and **clears the active initiative** (full clean slate). Use to abandon an initiative mid-flight, force-reset for testing, or begin a fresh cycle after COMPLETE. Pushes a history entry so the transition is visible in the trail.
- `mdocs_resume` — when the current step is `COMPLETE` or `IDLE`, it step-resets to IDLE then advances to `UNDERSTAND`, landing inside the gated region (auto-starts a fresh cycle). Mid-flight steps (`UNDERSTAND`…`REPORT`) are preserved unchanged. Uses `resumeAt('IDLE')` internally, NOT `reset()` — the active initiative id is kept.
- With no id and no active initiative, `mdocs_resume` returns the list of active initiatives (`resumable`) so you can offer choices.

Create-vs-resume activation design:

- `initiative.create` does NOT activate the initiative. Activation happens via `mdocs_resume` / `mdocs resume <id>`.
- Before creating, check for existing work: `mdocs_status`, `mdocs_resume` (no args → resumable list), `mdocs_lookup <query>`, or read `mdocs/initiatives/INDEX.md`.
- When a related initiative exists, offer resume instead of creating a duplicate.

---

## 5. Subagent Dispatch

Procedure:

1. Call `mdocs_dispatch({ initiativeId })` (omit `initiativeId` to use the active initiative).
2. It assembles the handoff context via `SubagentAssembler.assemble` (`src/core/subagent.ts`): objective, plan checklist, handoff summary, next action, blockers, progress log, artifacts, **Retrieved Memory** (search-ranked, top 5, scored, with snippets), **Related Wiki** (full content of `related_wiki` entries), **Recent Activity** (last 5 audit events for the initiative), and **Current Step**.
3. Paste the returned `context` string into your native subagent tool prompt:
   - OpenCode / Claude Code: native `Task` / `Agent` tool.
   - pi / Codex: no native subagent primitive — carry the bundle forward manually (paste into a new session or invocation).
4. In the subagent prompt, also include the current workflow step and explicit verification criteria.

Returns `{ context, initiativeId, step, relatedWikiCount }`. Errors when no initiativeId and no active initiative, or initiative not found.

---

## 6. Progress / Wiki Hygiene

- Append progress after substantial actions: `initiative.update` with `progressNote` (top level, not under `updates`). Progress log entries are auto-stamped with the workflow step by surface hooks (full initiative mode).
- Keep `next_action`, `blockers`, `open_questions`, `handoff_summary` current so a fresh agent can resume.
- Create wiki entries for durable learnings (decisions, architecture, how-tos): `wiki.create` with `lifecycle: 'stable'` when the knowledge is reusable.
- **Bidirectional linking**: use `wiki.link { initiativeId, wikiSlug }` — writes `related_wiki` on the initiative and `related_initiatives` on the wiki page, postcondition-verified on both sides (rolls back the initiative side if the wiki side fails). `wikiSlug` accepts `id` or `category/id`. Self-link to an initiative's own compiled page is provenance, not a link (`selfLink: true`).
- Batch wiki composition: `mdocs_ingest` with operations `createPage`, `updatePage`, `updateOverviewSection`, `appendLog`, `link`. Author all text yourself — ingest never auto-generates prose; it records and applies exactly what you supply, best-effort per op under a lock.
- **Completion gate**: before `initiative.done`, run `mdocs_validate`; ensure a done initiative has at least one linked **stable** wiki learning when the work produced reusable knowledge (`mdocs validate` warns otherwise). For completed initiatives, `lifecycle.graduate` records learning into `wiki/overview.md` + `wiki/log.md` and stamps `graduated`.
- Advisory lint rules (zero score impact): `long-running-active` (driven by `expected_duration`: `normal` >14d, `long` >60d, `suppress` never), `stale-complete` (completed >30d, not archived), `graduation-due` (completed >7d, not graduated).
- **INDEX consistency**: after any direct file edits bypassing mdocs commands, run `mdocs_index_check({ mode: 'check' })`; repair with `{ mode: 'repair' }` (or `index.sync` / `mdocs index repair`) to regenerate `mdocs/initiatives/INDEX.md`, `mdocs/wiki/INDEX.md`, and per-category wiki indices. Then run `mdocs_validate`.

---

## 7. Audit Trail Awareness

- Every mutating tool call is audit-logged with the workflow **step** and **timestamp** (NDJSON log, auto-rotating; see `mdocs/audit.log`).
- Bash is audited on every call even though it is not gated.
- Query with `mdocs_audit` (filters: `initiativeId`, `type`, `limit`, `startDate`, `endDate`; newest first).
- Progress-log entries appended by surface hooks are auto-stamped with the current workflow step.
- Audit configuration (`.mdocs.json`): `audit.level` (`full` | `metadata` | `off`), `audit.maxBytes`, `audit.maxBackups`. Env overrides: `MDOCS_AUDIT_LEVEL`, `MDOCS_AUDIT_MAX_BYTES`, `MDOCS_AUDIT_MAX_BACKUPS`. `metadata` level strips details to structural fields.
- Dispatch context includes the last 5 audit events for the initiative — subagents inherit awareness of recent activity.

---

## 8. Per-Surface Differences

From the README capability table:

| Surface | Command access | Workflow enforcement | Audit | Subagent dispatch |
| --- | --- | --- | --- | --- |
| OpenCode | native custom tools | enforced (hooks) | enforced (hooks) | native |
| Claude Code | MCP tools (+ CLI fallback) | enforced (PreToolUse hook) | enforced (PostToolUse hook) | native (`Task`) |
| pi | extension custom tools | enforced (`tool_call` event) | enforced (`tool_result` event) | prompted |
| Codex v1 | `mdocs` CLI | advisory (instructions) | command-level | prompted |

Notes:

- OpenCode / Claude Code / pi register the identical 13-tool canonical set (Section 1); enforcement hooks fail open — a hook error never wedges the session.
- Claude Code: PreToolUse blocks `Write`/`Edit` before `PLAN` (matcher `Write|Edit|Bash`); PostToolUse (matcher `Write|Edit|Bash|Task|Agent`) records audit under a lock (safe under parallel tool execution). SessionStart + PreCompact hooks emit an orientation banner.
- pi: `tool_call` event blocks `write`/`edit` before `PLAN`; `tool_result` records audit and, in full initiative mode, appends a progress-log entry. `before_agent_start` appends the orientation banner to the system prompt.
- Codex v1 limitations are intentional: gates are advisory instructions (not host-level), no write/destructive blocking, no automatic audit of every host tool call, CLI-only command access.
- Project root resolution is shared (`resolveProjectRoot` in `src/core/project-root.ts`): `MDOCS_PROJECT_DIR` env pin > nearest ancestor with `mdocs/` > cwd. Multi-project switching within one session is not supported.

---

## 9. File Formats

Initiatives live in `mdocs/initiatives/`, filename `<slug>--<YYYY-MM-DD>.md` (flat-v1) or a directory with `_status.md` (directory-v2).

Flat-v1 frontmatter:

```yaml
id: add-authentication
title: Add authentication
status: active            # active | paused | done  (directory-v2: complete; isCompleted() treats done/complete equally)
created: 2026-06-10
updated: 2026-06-10
owner: agent
tags: [auth, api]
related_wiki: [architecture/auth-flow]
aliases: [old-id]         # optional; graph validation resolves aliases to the canonical id
phase: implementation     # optional v2 metadata
handoff_summary: "..."
open_questions: ["..."]
blockers: ["..."]
next_action: "Run integration tests."
expected_duration: normal # normal | long | suppress — drives the long-running-active lint rule
```

Required body sections: Objective, Plan (`- [ ]` / `- [/]` / `- [x]`), Progress Log, Artifacts.

Wiki entries live in `mdocs/wiki/<category>/<id>.md` (root pages like `overview.md`, `log.md`, `glossary.md`, `index.md` are first-class entries with an empty category). Frontmatter: `id`, `title`, `category`, `created`, `updated`, `related_initiatives`, `tags`, `lifecycle` (`stable` for durable learning), `knowledge_type`, `confidence`, `source_initiatives`, `supersedes`, `related_wiki`. The `## Referenced By` section is auto-generated on create/update and stripped on read.

Generated state files: `mdocs/.workflow-state.json` (workflow), `mdocs/.index-meta.json` (last index sync), `mdocs/audit.log` (NDJSON, rotating).

## 10. Config Keys (`.mdocs.json` + Env)

Recognized `.mdocs.json` keys (`src/core/config.ts`): `compatibility`, `standaloneCategories`, `mdocsDirName`, `audit`, `wiki`.

- `compatibility.initiativeRecordMode: "metadata-only"` — `_status.md` is thin lifecycle metadata: only lifecycle keys (`status`/`updated`/`completed`/`graduated`) rewritten in place; no `## Objective`/`## Plan`/`## Progress Log` injection; PostToolUse records audit only (no progress-log mutation).
- `compatibility.enforcementMode: "advisory"` — trail without friction.
- `standaloneCategories: ["repos", "systems", "glossary"]` — consumer wiki categories treated as standalone.
- `audit.level` / `audit.maxBytes` / `audit.maxBackups`.

Env vars present in source: `MDOCS_ENFORCEMENT`, `MDOCS_ENFORCEMENT_IDLE`, `MDOCS_AUDIT_LEVEL`, `MDOCS_AUDIT_MAX_BYTES`, `MDOCS_AUDIT_MAX_BACKUPS`, `MDOCS_PROJECT_DIR`, `MDOCS_DIR_NAME`, `MDOCS_ORCHESTRATOR_IDENTITY`. Precedence: env > `.mdocs.json` file > detected contract.

Every surface reports its build fingerprint (`version` + `gitSha`) — via `mdocs_status` output, the MCP handshake version, or `mdocs --version`. Use it to confirm which build a session is running before trusting behavior.

## 11. Session Start & Orientation

- Claude Code: SessionStart hook injects a compact orientation banner (initiative counts by status, active initiative id/title + workflow step, wiki page count, pointer to `mdocs_status`); PreCompact re-emits it so orientation survives compaction. Backed by `sessionContext` in `src/core/operations.ts`.
- pi: `before_agent_start` appends the banner to the system prompt each turn, plus a `session_start` user notification.
- All enforcement/orientation hooks fail open — a hook error never wedges the session.
- OpenCode initializes `./mdocs` automatically through its config hook on first run; other surfaces run `mdocs init` (tool: `mdocs_init`).
- Plugin installs into a running session do not retroactively register tools/hooks — a fresh session is required after install/update; missing `mdocs_*` MCP tools before restart is expected.

## 12. Failure Modes & Recovery

- Blocked Write/Edit → you are before `PLAN`; run `mdocs_advance` (or `mdocs step PLAN` on CLI). Do not work around the gate.
- `mdocs_resume` returns `{ resumable: [...] }` when no initiative is active — pick one or create.
- `initiative.update` / `wiki.update` verify writes by re-reading from disk; a `postcondition failed` result lists `failedFields` — fix and retry rather than assuming the write landed.
- `wiki.link` is all-or-nothing: if the wiki side fails after the initiative side was written, the initiative side is rolled back surgically.
- Direct file edits bypassing commands → indices go stale. `mdocs_index_check({ mode: 'check' })`, then `mode: 'repair'` (or `mdocs index repair`), then `mdocs_validate`.
- `mdocs_reset` is the clean-slate primitive: abandon mid-flight, force-reset for testing, or restart after COMPLETE.

## Quick Command Reference (CLI)

```bash
mdocs init
mdocs status
mdocs resume [initiative-id]
mdocs reset
mdocs lookup <query>
mdocs search <query>
mdocs dispatch [initiative-id]
mdocs step <step>
mdocs validate [--human]
mdocs index check | mdocs index repair
mdocs command --help
mdocs command initiative.create --json '{"title":"..."}'
mdocs --version   # build fingerprint
```

`valid=true` is the pass/fail field of validate; `clean=false` means warnings exist but no errors.
