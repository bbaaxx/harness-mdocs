# Codex Repo Install Playbook

This playbook installs and dogfoods the local `harness-mdocs` Codex plugin at the repository level.

It mirrors the `opencode-mdocs` dogfooding strategy:

- opencode local development loads built runtime output and adds a local discovery shim for startup-discovered assets.
- Codex local development installs from a repo-scoped marketplace and adds a repo-local CLI shim so plugin skills can run `mdocs` commands from this project.

Codex v1 remains advisory. The plugin skills guide workflow behavior; they do not block host file edits, shell commands, or automatically audit host tool calls.

## Source Basis

- `opencode-mdocs` dogfooding uses `npm run setup:local` to symlink `.opencode/agents/mdocs-orchestrator.md` to `agents/mdocs-orchestrator.md`, because opencode discovers agents before plugin config hooks run.
- Codex supports repo skills under `.agents/skills`, repo marketplace files under `.agents/plugins/marketplace.json`, local plugin marketplace entries, and symlinked skill folders.
- Codex plugin installation makes bundled skills available, but command-line tools still need to be available in the project shell if skills tell Codex to run them. The Codex plugin install does not install `mdocs` on `PATH`.

## Repo Files

This repository includes:

```text
.agents/
  bin/
    mdocs
  plugins/
    marketplace.json
src/surfaces/codex/plugin/
  .codex-plugin/plugin.json
  skills/
    mdocs-workflow/SKILL.md
    mdocs-initiative/SKILL.md
    mdocs-orchestrator/SKILL.md
```

The marketplace entry points at `./src/surfaces/codex/plugin`.

The `mdocs` shim runs `node dist/cli/index.js`, so it requires a fresh build.
This shim is for dogfooding the source checkout. Published-package users should
prefer `npm exec -- mdocs <command>`, `./node_modules/.bin/mdocs <command>`, or
a global `mdocs` from `npm install -g harness-mdocs`.

## One-Time Local Setup

Run from the `harness-mdocs` repo root:

```bash
npm install
npm run build
chmod +x .agents/bin/mdocs
```

Validate the plugin package:

```bash
/Users/bbaaxx/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  /Users/bbaaxx/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  src/surfaces/codex/plugin
```

Smoke-test the CLI shim:

```bash
PATH="$PWD/.agents/bin:$PATH" mdocs status
```

If `mdocs status` prints JSON workflow state, the CLI side of the dogfood setup is ready.
If the same command fails outside the `harness-mdocs` repo root, that is expected
unless another install path exposes `mdocs` on `PATH`.

## Install In Codex From The Repo Marketplace

Start Codex from the `harness-mdocs` repo root with the local shim on `PATH`:

```bash
PATH="$PWD/.agents/bin:$PATH" codex
```

Open the plugin browser:

```text
/plugins
```

Then:

1. Select the `harness-mdocs-local` marketplace.
2. Open `Mdocs`.
3. Install the plugin.
4. Restart Codex or start a new Codex thread from the same repo root.

After installation, invoke the plugin or skill explicitly once:

```text
@Mdocs Resume mdocs work
```

or:

```text
$mdocs-orchestrator Resume mdocs work
```

Use a new thread after install or plugin changes. Codex loads plugin skills at thread startup.

## Dogfood Verification Loop

Run this loop whenever the Codex plugin, skills, or CLI changes:

```bash
npm run build
npm test
/Users/bbaaxx/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  /Users/bbaaxx/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  src/surfaces/codex/plugin
PATH="$PWD/.agents/bin:$PATH" mdocs validate
```

Then start a fresh Codex thread from the repo root:

```bash
PATH="$PWD/.agents/bin:$PATH" codex
```

Ask Codex:

```text
@Mdocs Create an mdocs initiative for validating Codex repo-level dogfooding. Use the CLI, create a wiki stub, run validation, and summarize the result.
```

Expected behavior:

- Codex can see the Mdocs plugin and bundled skills.
- Codex can run `mdocs init`, `mdocs status`, `mdocs command ...`, `mdocs lookup`, `mdocs search`, `mdocs dispatch`, and `mdocs validate`.
- New files appear under `./mdocs/`.
- `mdocs validate` returns a JSON validation result.
- Any workflow-gate language stays advisory.

## Updating The Local Plugin

After editing plugin files:

```bash
npm run build
/Users/bbaaxx/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  /Users/bbaaxx/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  src/surfaces/codex/plugin
```

Restart Codex or open a new thread. If the plugin browser does not show changes, refresh marketplaces:

```bash
codex plugin marketplace list
codex plugin marketplace upgrade harness-mdocs-local
```

If the local marketplace is not listed, add this repo root as a local marketplace source:

```bash
codex plugin marketplace add "$PWD"
```

The checked-in `.agents/plugins/marketplace.json` is the source of truth for repo-level discovery.

## Optional Direct Skill Fallback

For fast skill-only iteration, use repo-scoped skill symlinks. This bypasses plugin installation and should not replace plugin dogfooding.

```bash
mkdir -p .agents/skills
ln -sfn ../../src/surfaces/codex/plugin/skills/mdocs-workflow .agents/skills/mdocs-workflow
ln -sfn ../../src/surfaces/codex/plugin/skills/mdocs-initiative .agents/skills/mdocs-initiative
ln -sfn ../../src/surfaces/codex/plugin/skills/mdocs-orchestrator .agents/skills/mdocs-orchestrator
```

Use this only to iterate on skill wording. Before release, remove or ignore the symlinks and verify through the plugin marketplace path.

## Troubleshooting

### Plugin Does Not Appear

- Confirm Codex was started from the `harness-mdocs` repo root.
- Confirm `.agents/plugins/marketplace.json` exists.
- Run `codex plugin marketplace list`.
- Restart Codex or open a new thread.

### Skills Appear But `mdocs` Fails

- Rebuild: `npm run build`.
- Confirm the shim works: `PATH="$PWD/.agents/bin:$PATH" mdocs status`.
- Start Codex with the same `PATH="$PWD/.agents/bin:$PATH"` prefix.
- If you are not dogfooding this source checkout, install the package as a
  project dependency and use `npm exec -- mdocs status`, or install it globally
  and use `mdocs status`.

### Plugin Installs But Old Skill Text Persists

- Restart Codex.
- Open a new thread.
- Run `codex plugin marketplace upgrade harness-mdocs-local`.
- Confirm the marketplace path still points to `./src/surfaces/codex/plugin`.

### Validation Fails

Run:

```bash
npm test
npm run build
/Users/bbaaxx/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  /Users/bbaaxx/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  src/surfaces/codex/plugin
```

Fix plugin manifest or skill frontmatter issues before starting a new dogfood thread.

## Release Readiness Checklist

- `npm run build` passes.
- `npm test` passes.
- Codex plugin validator passes.
- `npm --cache .npm-cache pack --dry-run` includes `src/surfaces/codex/plugin`.
- Repo marketplace installs `Mdocs`.
- Fresh Codex thread can invoke Mdocs skills.
- Fresh Codex thread can run the repo-local `mdocs` CLI through the shim.
- Codex docs and skills state that v1 enforcement is advisory only.
