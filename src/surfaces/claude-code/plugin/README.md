# Mdocs — Claude Code Plugin

Durable initiative and wiki memory for Claude Code.

## Schema verified (2026-06-11)

Verified against official docs at `code.claude.com/docs/en/plugins-reference` and `code.claude.com/docs/en/plugin-marketplaces`.

| Aspect | Verified |
|---|---|
| `plugin.json` | `name` required; hooks/mcpServers inline; `skills`/`agents` as paths |
| `marketplace.json` | `name`, `owner.name`, `plugins[]` required; `source` as relative path string `"./..."` |
| Hooks | `PreToolUse`/`PostToolUse` events; `matcher` pipe-separated; `${CLAUDE_PLUGIN_ROOT}` expanded |
| MCP | `mcpServers` inline; `${CLAUDE_PLUGIN_ROOT}` expanded; `${CLAUDE_PROJECT_DIR}` for workspace |
| `${CLAUDE_PLUGIN_ROOT}` | Resolves to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` |

### Decision: committed dist

The marketplace installs from this git repo (relative path source). Plugins are copied to cache, so `dist/` must be present inside the plugin directory in git. Build script `npm run build:claude-plugin` copies `dist/` + syncs skill/agent files from assets.

### Note on `${CLAUDE_PROJECT_DIR}`

The MCP `env.MDOCS_PROJECT_DIR` uses `${CLAUDE_PROJECT_DIR}` (the official workspace variable). If unset, the hook falls back to `process.cwd()`.

## Install (via marketplace)

```bash
/plugin marketplace add <owner>/harness-mdocs
/plugin install mdocs@harness-mdocs
```

## Install (manual fallback)

See the [main README](../../../../README.md) for the manual `.claude/settings.json` patch path.

## Build

```bash
npm run build:claude-plugin
```

This runs `npm run build`, copies the needed `dist/` subset into this plugin directory, and syncs skill/agent files from `assets/`.
