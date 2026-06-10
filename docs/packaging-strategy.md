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

## Publish checklist

Before publish:

1. Run `npm run build`.
2. Run `npm test -- --runInBand`.
3. Run `npm --cache .npm-cache pack --dry-run`.
4. Inspect the dry-run tarball contents for `dist`, `agents`, `skills`, `prompts`, `templates`, README, and LICENSE.

After publish and replacement in a consuming folder:

1. Update `.opencode/opencode.json` from `opencode-mdocs@1.3.2` to `harness-mdocs` or `harness-mdocs/opencode`.
2. Restart OpenCode.
3. Verify mdocs custom tools, the `mdocs-orchestrator` agent, bundled skills, and existing `./mdocs` data load correctly.
