# Kimi Code surface

`harness-mdocs` ships a first-class [Kimi Code CLI](https://www.kimi.com/code/docs/en/) surface so Kimi Code users get the canonical mdocs MCP tools, workflow enforcement via `PreToolUse` hooks, audit logging via `PostToolUse`, session orientation via `SessionStart`, and bundled skills plus an orchestrator agent. It is a Tier 3 surface — full host-level enforcement, on par with OpenCode and Claude Code.

## Install

### Option A — Kimi plugin (recommended)

The plugin manifest lives inside the npm package. Install it as a project dependency, then point Kimi Code's plugin manager at the bundled plugin directory:

```bash
npm install --save-dev harness-mdocs
```

In the Kimi Code TUI:

```
/plugins install ./node_modules/harness-mdocs/src/surfaces/kimi-code/plugin
```

Then run `/reload` or start a new session. The plugin provides everything: the `mdocs` MCP server, the three workflow hooks, the three skills, and the `mdocs-orchestrator` agent.

Plugin installs are currently **per-user** (they apply across projects); project-scoped plugin installation is not yet supported by Kimi Code. The MCP server and hooks resolve the project root from the session cwd (walk-up to the nearest `mdocs/` directory), so one plugin install works across projects.

### Option B — manual wiring (no plugin)

1. **MCP tools** — copy `src/surfaces/kimi-code/assets/templates/kimi-mcp.json` from the package to `.kimi-code/mcp.json` in your project (adjust the path if needed):

```json
{
  "mcpServers": {
    "mdocs": {
      "command": "node",
      "args": ["./node_modules/harness-mdocs/dist/cli/index.js", "mcp"]
    }
  }
}
```

2. **Hooks** — add `[[hooks]]` rules to `~/.kimi-code/config.toml` (the kimi-translated hook entries ship compiled in the package):

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Write|Edit|Bash"
command = "node /abs/path/to/node_modules/harness-mdocs/dist/surfaces/kimi-code/cli/pre-tool-use.js"
timeout = 10

[[hooks]]
event = "PostToolUse"
matcher = "Write|Edit|Bash|Agent|AgentSwarm"
command = "node /abs/path/to/node_modules/harness-mdocs/dist/surfaces/kimi-code/cli/post-tool-use.js"
timeout = 10

[[hooks]]
event = "SessionStart"
matcher = "startup|resume"
command = "node /abs/path/to/node_modules/harness-mdocs/dist/surfaces/kimi-code/cli/session-start.js"
timeout = 10
```

Project-level hook config files are not supported by Kimi Code; hooks live in user `config.toml` or a plugin manifest.

3. **Skills/agents** — copy `src/surfaces/kimi-code/assets/skills/` into `.kimi-code/skills/` and `src/surfaces/kimi-code/assets/agents/` into `.kimi-code/agents/`.

Restart the session after changing any of the above — MCP servers and hooks join sessions at creation; a running session does not pick them up.

## Capabilities

| Capability | kimi-code surface |
| --- | --- |
| Command access | MCP tools (`mcp__mdocs__*`) + CLI fallback |
| Workflow enforcement | enforced (`PreToolUse` hook, exit 2) |
| Audit | enforced (`PostToolUse` hook) |
| Orientation | `SessionStart` hook stdout → session context |
| Skills | packaged (plugin `skills/`, project `.kimi-code/skills/`) |
| Agents | packaged (plugin `agents/`, project `.kimi-code/agents/`) |
| Subagent dispatch | native (`Agent` tool) |
| Config mutation | no |
| SessionStart skill | `mdocs-workflow` loaded at session start |

The capability table is exported from `harness-mdocs/kimi-code` as `kimiCodeSurface`.

## Tools

The same canonical 13-tool set every tool-bearing surface registers, exposed as `mcp__mdocs__<tool>`:

| Tool | Purpose |
| --- | --- |
| `mdocs` | Run any core command (`initiative.*`, `wiki.*`, `workflow.advance`, `lifecycle.graduate`, `validate`, `index.sync`). |
| `mdocs_init` | Initialize the `./mdocs` structure (idempotent). |
| `mdocs_status` | Current workflow state, active initiative, validation summary. |
| `mdocs_validate` | Validate initiatives, wiki, and graph links. |
| `mdocs_search` | Search initiatives and wiki memory. |
| `mdocs_lookup` | Resolve an initiative by id, title, or slug. |
| `mdocs_dispatch` | Assemble subagent context for an initiative. |
| `mdocs_ingest` | Batch-compose wiki pages + compiled views from caller-supplied operations. |
| `mdocs_audit` | Query the audit log. |
| `mdocs_index_check` | Check (or repair) index consistency. |
| `mdocs_resume` | Resume an active initiative. |
| `mdocs_advance` | Advance the workflow step; drives the Write/Edit gate. |
| `mdocs_reset` | Reset the workflow to IDLE and clear the active initiative. |

## Enforcement semantics

- `Write`/`Edit` are blocked before `PLAN` and allowed from `PLAN` through `COMPLETE`. Edits under `./mdocs/` are always allowed.
- `Bash` is audited but never blocked by content.
- Read tools (`Read`, `Grep`, `Glob`, `ReadMediaFile`) are always allowed.
- Hooks fail open: a hook error or timeout never blocks your work — only an explicit, successful gate denial exits 2.

## Subagent dispatch

Kimi Code has native subagents. Call `mcp__mdocs__mdocs_dispatch` to assemble the handoff context (objective, plan, blockers, next action, related wiki, recent audit), then pass the bundle into the `Agent` tool prompt. The packaged `mdocs-orchestrator` agent does this automatically.

## Limitations (v1)

- Plugins install per-user, not per-project; the plugin route shares one install across projects.
- Plugin hook commands run with cwd = plugin root, so the manifest references `./dist/...` paths; the bundled scripts are self-contained (esbuild, no external requires).
- Mid-session plugin or MCP changes require `/reload` or a new session.
- `deferred: true` MCP tool loading (experimental) is not declared by the plugin; all 13 tools are exposed inline.
