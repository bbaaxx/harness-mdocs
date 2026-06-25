# pi surface

`harness-mdocs` ships a first-class [pi](https://pi.dev) surface so pi users can install the package as a pi package and get mdocs custom tools, workflow enforcement via the `tool_call` event, audit logging + progress via `tool_result`, session orientation, and bundled skills. It is a Tier 3 surface — full host-level enforcement, on par with OpenCode and Claude Code.

## Install

Install as a pi package (global by default; use `-l` for project settings):

```bash
pi install npm:harness-mdocs
```

Or try it without installing, for the current run only:

```bash
pi -e npm:harness-mdocs
```

Local-path / git checkouts work too:

```bash
pi -e ./path/to/harness-mdocs
pi install git:github.com/bbaaxx/harness-mdocs
```

### Dogfooding this repo

The `pi` manifest in `package.json` points the extension at the compiled `./dist/surfaces/pi/extension.js` and the skills at `./src/surfaces/pi/assets/skills`. `prepare`/`prepack` run `npm run build`, so published tarballs ship `dist`. For a git or local-path checkout, build first:

```bash
npm run build
pi -e ./
```

Confirm the surface loaded: the `mdocs_status` tool is callable and the three `mdocs-*` skills appear in `/skill:` completion.

## Capabilities

| Capability | pi surface |
| --- | --- |
| Command access | extension custom tools |
| Workflow enforcement | enforced (`tool_call` event) |
| Audit | enforced (`tool_result` event) |
| Orientation | `before_agent_start` banner + `session_start` notify |
| Skills | packaged (`pi.skills`) |
| Subagent dispatch | prompted (no native primitive) |
| Config mutation | no |
| Permission hooks | n/a (replaced by `tool_call` blocking) |

The capability table is exported from `harness-mdocs/pi` as `piSurface`.

## Tools

All tools carry `promptSnippet` (one-line `Available tools` entry) and `promptGuidelines` (bullets appended to the `Guidelines` section) so the model discovers them in the system prompt. Schemas use TypeBox.

| Tool | Purpose |
| --- | --- |
| `mdocs` | Run any core command (`initiative.*`, `wiki.*`, `workflow.advance`, `lifecycle.graduate`, `validate`, `index.sync`). |
| `mdocs_init` | Initialize the `./mdocs` structure (idempotent). |
| `mdocs_status` | Current workflow state, active initiative, blocked/overdue, validation summary. |
| `mdocs_validate` | Validate initiatives, wiki, and graph links. |
| `mdocs_search` | Search initiatives and wiki by keyword with optional filters. |
| `mdocs_lookup` | Resolve an initiative by id, title, slug, or filename. |
| `mdocs_dispatch` | Assemble subagent handoff context for an initiative. |
| `mdocs_ingest` | Batch-compose wiki pages + `overview.md`/`log.md` from caller-supplied ops (no auto-prose). |
| `mdocs_audit` | Query the audit log. |
| `mdocs_index_check` | Check (or repair) index consistency. |
| `mdocs_resume` | Resume the active or specified initiative; auto-starts a fresh cycle at `UNDERSTAND` after `COMPLETE`/`IDLE`. |
| `mdocs_advance` | Advance the workflow to the next step. |
| `mdocs_reset` | Reset to `IDLE` and clear the active initiative. |

Results are wrapped to the pi tool shape (`{ content: [{ type:'text', text }], details }`). A core `{ error: string }` payload is surfaced with `isError: true` so the model treats the call as failed and self-corrects.

## Enforcement

The `tool_call` event handler calls `core.managers.workflow.canExecuteTool(toolName, input)` and returns `{ block: true, reason }` when blocked.

- `write` / `edit` are blocked before `PLAN` and allowed from `PLAN` through `COMPLETE`.
- Edits under `./mdocs/` are always allowed (core whitelists mdocs paths).
- `bash` is audited but not gated by content.
- `read` / `grep` / `find` / `ls` are always allowed.

If a tool is blocked, advance the workflow (`mdocs_advance`) rather than working around the gate.

**Configuration:** enforcement mode `gate` (default) | `advisory` | `off` (env `MDOCS_ENFORCEMENT`); IDLE strictness `open` (default) | `readonly` (env `MDOCS_ENFORCEMENT_IDLE`); precedence env > `.mdocs.json` > detected contract. See the README [Enforcement](../README.md#enforcement) section for the full shared configuration reference.

## Audit and progress

The `tool_result` event appends a `tool` audit event for every tool call (unlocked — append-only and safe under pi's parallel tool execution). In full initiative mode it also appends a progress-log entry to the active initiative under `withLock` when the step is not `IDLE`. In `metadata-only` mode (`compatibility.initiativeRecordMode: "metadata-only"` in `.mdocs.json`) the progress-log mutation is skipped so a thin consumer `_status.md` is not injected with a `## Progress Log` section; the audit entry remains the only record.

## Orientation

`before_agent_start` appends a compact markdown banner to the system prompt each turn (workflow step, active initiative, counts, quick reference, enforcement reminder). `session_start` emits a one-line user notification (`mdocs active (step …)`). Both are fail-open and kept small (~1 KB) to avoid prompt noise.

## Skills

Three skills ship under `src/surfaces/pi/assets/skills/` and are declared in `package.json#pi.skills`:

- `mdocs-workflow` — step-by-step workflow guide for pi.
- `mdocs-initiative` — initiative file/schema reference for pi.
- `mdocs-orchestrator` — primary entry point and subagent dispatch story for pi.

Load them with `/skill:mdocs-orchestrator`, `/skill:mdocs-workflow`, `/skill:mdocs-initiative`.

An `AGENTS.md` / `CLAUDE.md` snippet template ships at `src/surfaces/pi/assets/templates/pi-agents-md-snippet.md` for consumers to paste into their project memory file.

## Subagent dispatch

pi has no native subagent primitive. `mdocs_dispatch` returns an assembled context bundle (initiative state, related wiki, search-ranked memory, recent audit events). Carry it forward manually — paste it into a new session (`/new`), another invocation, or a follow-up prompt. A future version may add a `/mdocs-subagent` command that seeds a new session and sends a kickoff prompt; that is intentionally out of scope for the initial pi surface.

## Project root resolution

The extension resolves the project root with the shared `resolveProjectRoot(process.cwd())` helper, so the pi surface agrees with the MCP server and CLI hooks when the session starts in a subdirectory. Precedence: `MDOCS_PROJECT_DIR` env (if it points at an existing directory) → nearest ancestor containing `mdocs/` → `cwd`. pi reloads extensions on session switch/reload, so state naturally refreshes.

## Fail-open guarantee

Every event handler (`tool_call`, `tool_result`, `before_agent_start`, `session_start`) is wrapped in `try/catch` and never throws — a thrown handler can wedge the agent. A failing gate fails open (allows the call); a failing audit/orientation fails silently. Tool `execute` functions catch all errors and surface them via `toPiToolError`.

## Limitations compared to Claude Code / OpenCode

- No native subagent dispatch (prompted only).
- No config mutation / permission-prompt hooks (pi's `tool_call` blocking replaces them).
- No MCP server (pi uses extension tools directly).
- The extension loads as a package extension; it does not depend on project trust.

## Programmatic use

```ts
import { createPiAdapter, createPiTools, piSurface } from 'harness-mdocs/pi';

const { core } = createPiAdapter(projectDir);
const tools = createPiTools(core); // PiToolDefinition[]
console.log(piSurface.capabilities);
```

The extension factory is the default export of `harness-mdocs/pi` (`createPiExtension`) and is what the `pi` manifest loads.
