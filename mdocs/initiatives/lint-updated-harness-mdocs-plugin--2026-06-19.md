---
id: "lint-updated-harness-mdocs-plugin"
title: "Lint updated harness-mdocs plugin"
status: "active"
created: "2026-06-19"
updated: "2026-06-19"
owner: ""
tags: ["lint","plugin","verification","harness-mdocs"]
related_wiki: []
priority: "medium"
---

## Objective
Run lint against the recently updated harness-mdocs plugin version and report whether it passes.

## Plan


## Progress Log
- [2026-06-19T19:02:07.153Z] Created initiative via mdocs command
- Inspected package.json: no `lint` script is defined. Ran `npm run lint`; command failed with npm Missing script: "lint". No code changes made.
- Clarified requested check was mdocs lint, not npm lint. Source inspection shows lint is exposed through validate (`MdocsLinter.lintAll` in core validation). Ran `mdocs_validate`; result passed with initiatives, wiki, and graph all valid and no warnings/errors.
- Discussed CI/CD integration options. Repository currently has no .github/workflows and package scripts lack lint/ci/mdocs validation wrappers. Recommended adding package scripts for lint (tsc --noEmit), mdocs:validate (built CLI validate), pack:check, ci aggregate, plus GitHub Actions workflow running npm ci and npm run ci across Node 18/20/22.

## Artifacts
