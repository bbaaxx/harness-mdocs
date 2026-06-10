# harness-mdocs

Surface-neutral mdocs for AI coding harnesses.

The package exposes a shared core plus harness adapters. Core owns initiative/wiki storage, workflow state, validation, search, audit, and command behavior. Surfaces translate the core into a host integration such as opencode or Codex.

## Entry Points

- `harness-mdocs`: default OpenCode plugin entrypoint, suitable for `opencode.json` plugin configuration.
- `harness-mdocs/core`: surface-neutral managers, workflow, command registry, validation, search, audit, and dispatch.
- `harness-mdocs/opencode`: opencode adapter preserving the current plugin behavior.
- `harness-mdocs/plugin`: OpenCode compatibility alias mirroring the legacy `opencode-mdocs/plugin` entrypoint.
- `harness-mdocs/codex`: Codex v1 surface metadata and plugin packaging.
- `mdocs`: CLI command access for surfaces that do not expose native tools.

## Publishing and OpenCode Migration

`harness-mdocs` is the primary package going forward. Publish it directly and configure OpenCode to load either the package root or the explicit OpenCode surface:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["harness-mdocs"]
}
```

Use `harness-mdocs/opencode` when you want the config to document the selected surface explicitly. `harness-mdocs/plugin` exists as a compatibility alias for users familiar with `opencode-mdocs/plugin`.

The legacy `opencode-mdocs` package does not need to remain installed beside `harness-mdocs` for new installs. Existing consumers can migrate by replacing `opencode-mdocs@1.3.2` with `harness-mdocs`, restarting OpenCode, and verifying that the bundled mdocs tools, agent, and skills load against the existing `./mdocs` directory.

See `docs/packaging-strategy.md` for the release decision and replacement checklist.

## Codex V1 Enforcement

Codex v1 workflow gates are advisory. The plugin skills instruct Codex when to read, plan, edit, verify, and report, but v1 does not block host tool calls or automatically audit every host tool execution. Command access is CLI-backed through `mdocs`; v1 does not expose native Codex command tools or MCP tools.
