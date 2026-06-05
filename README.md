# harness-mdocs

Surface-neutral mdocs for AI coding harnesses.

The package exposes a shared core plus harness adapters. Core owns initiative/wiki storage, workflow state, validation, search, audit, and command behavior. Surfaces translate the core into a host integration such as opencode or Codex.

## Entry Points

- `harness-mdocs/core`: surface-neutral managers, workflow, command registry, validation, search, audit, and dispatch.
- `harness-mdocs/opencode`: opencode adapter preserving the current plugin behavior.
- `harness-mdocs/codex`: Codex v1 surface metadata and plugin packaging.
- `mdocs`: CLI command access for surfaces that do not expose native tools.

## Codex V1 Enforcement

Codex v1 workflow gates are advisory. The plugin skills instruct Codex when to read, plan, edit, verify, and report, but v1 does not block host tool calls or automatically audit every host tool execution.
