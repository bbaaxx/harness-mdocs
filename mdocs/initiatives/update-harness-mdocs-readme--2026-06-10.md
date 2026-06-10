---
id: "update-harness-mdocs-readme"
title: "Update harness-mdocs README"
status: "done"
created: "2026-06-10"
updated: "2026-06-10"
owner: "bbaaxx"
tags: ["docs","readme","harness-mdocs","opencode-migration"]
related_wiki: ["docs/surface-neutral-readme-guidance"]
priority: "medium"
phase: "done"
next_action: "No follow-up required; README now explains harness-mdocs as a surface-neutral package across OpenCode and Codex."
---

## Objective
Rewrite the harness-mdocs README so it clearly explains the surface-neutral package, installation and migration paths, Codex v1 CLI-backed workflow, OpenCode compatibility, mdocs concepts, and command usage. Use the previous opencode-mdocs README as structural inspiration while keeping harness-mdocs language accurate and surface-neutral.

## Plan
- [ ] Compare the current harness-mdocs README with the previous opencode-mdocs README structure
- [ ] Identify sections to preserve conceptually: purpose, philosophy, installation, first run, workflow, knowledge system, CLI/custom command usage, architecture, migration notes
- [ ] Draft a revised README that is concise but complete for both OpenCode and Codex users
- [ ] Keep Codex v1 claims honest: CLI-backed command access only, advisory workflow gates, no native Codex/MCP command tools
- [ ] Verify links, package entry points, command examples, and build/test expectations
- [ ] Run documentation-appropriate verification and mdocs validate
- [ ] Record stable wiki learning if the README update captures reusable documentation guidance

## Progress Log
- [2026-06-10T15:45:01.280Z] Created initiative via mdocs command
- [2026-06-10T16:00:00Z] PASS: Rewrote README.md using the previous opencode-mdocs README as structural inspiration while keeping harness-mdocs language surface-neutral and Codex v1 claims honest. Covered purpose, philosophy, install, OpenCode usage, Codex CLI-backed usage, first run, entry points, migration from opencode-mdocs, workflow, initiatives, wiki, CLI examples, OpenCode custom tools, architecture, development, and notes. Files changed: README.md plus mdocs initiative/wiki memory. Verification: npm run build PASS; npm run test:codex PASS (2 suites, 4 tests); npm run test:opencode PASS (4 suites, 54 tests); npm test -- --runInBand PASS (20 suites, 190 tests); PATH=$PWD/.agents/bin:$PATH mdocs validate PASS; git diff --check PASS. Follow-ups: none.
- [2026-06-10T15:53:26.929Z] Marked done via mdocs command

## Artifacts
