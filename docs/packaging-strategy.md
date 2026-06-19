# harness-mdocs packaging strategy

## Decision

`harness-mdocs` is the primary package for new releases. It carries the shared mdocs core plus surface adapters. OpenCode consumers should migrate from `opencode-mdocs@1.3.2` to `harness-mdocs` rather than installing both packages.

## Package entrypoints

- `harness-mdocs` — default OpenCode plugin entrypoint for `opencode.json`.
- `harness-mdocs/opencode` — explicit OpenCode surface entrypoint.
- `harness-mdocs/plugin` — compatibility alias matching the legacy `opencode-mdocs/plugin` shape.
- `harness-mdocs/api` — public API helpers.
- `harness-mdocs/core` — surface-neutral core managers and workflow primitives.
- `harness-mdocs/codex` — Codex v1 surface metadata and packaging.
- `mdocs` — CLI command for surfaces without native tool hooks.

## CLI availability

The npm package declares `bin.mdocs = dist/cli/index.js`. A project install
exposes that command through `npm exec -- mdocs <command>` and
`./node_modules/.bin/mdocs <command>`. A global install exposes `mdocs` directly
on the shell `PATH`.

OpenCode plugin loading is separate from shell command installation. Loading
`harness-mdocs` or `harness-mdocs/opencode` lets OpenCode use package hooks,
agents, skills, and custom tools from its plugin cache, but it does not imply
that a terminal, Codex session, or other harness can run `mdocs` by name. Those
surfaces need a project install, a global install, or a local shim.

The checked-in `harness-mdocs/.agents/bin/mdocs` shim is only for repo
dogfooding. It runs the built `dist/cli/index.js`, so it requires `npm run
build` before use.

## OpenCode migration path

Replace the existing plugin entry in `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["harness-mdocs"]
}
```

`harness-mdocs/opencode` is also valid if the config should name the selected surface explicitly.

After changing the config, restart OpenCode. The running process does not reload plugin config dynamically.

## Legacy opencode-mdocs package

Do not require `opencode-mdocs` beside `harness-mdocs` for new installs. If backwards compatibility on npm is needed later, publish a small `opencode-mdocs` wrapper/deprecation release that depends on and re-exports `harness-mdocs/opencode`; that is a separate release decision and is not required before publishing `harness-mdocs`.

## CI/CD phases

Phase 1 validates integration and pre-publish readiness without publishing:

1. Pull requests targeting `staging` run `npm run quality` on Node 18 and 20.
2. Pushes to `staging` run `npm run quality` in the GitHub `staging` environment.
3. Pushes to `main` run `npm run release:check` in the GitHub `release` environment.
4. Version tags matching `v*` also run `npm run release:check` in the `release` environment.

Phase 2 will add actual npm publishing on version tags after release checks and environment approval. Until then, tag workflows are pre-publish validation only.

## Publish checklist

Before publish:

1. Run `npm run release:check` locally or confirm the GitHub `release` environment check passed.
2. Inspect the dry-run tarball contents for `dist`, `agents`, `skills`, `prompts`, `templates`, README, and LICENSE.
3. Confirm the package metadata still includes `bin.mdocs`.

After publish and replacement in a consuming folder:

1. Update `.opencode/opencode.json` from `opencode-mdocs@1.3.2` to `harness-mdocs` or `harness-mdocs/opencode`.
2. Restart OpenCode.
3. Verify mdocs custom tools, the `mdocs-orchestrator` agent, bundled skills, and existing `./mdocs` data load correctly.
