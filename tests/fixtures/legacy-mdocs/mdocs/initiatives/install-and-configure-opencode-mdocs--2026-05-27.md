---
id: "install-mdocs"
title: "Install and Configure opencode-mdocs"
status: "done"
created: "2026-05-27"
updated: "2026-05-27"
owner: "system"
tags: ["setup","plugin"]
related_wiki: ["architecture/implementation-plan"]
---

## Objective
Install and configure the opencode-mdocs plugin in the project.

## Plan
- [x] Install npm package via `npm install`
- [x] Configure `opencode.json` with plugin path and agent settings
- [x] Copy `agents/mdocs-orchestrator.md` to `.opencode/agents/`
- [x] Verify workflow by checking `mdocs_status` tool output

## Progress Log
- Plugin installed
- Configured opencode.json with mdocs settings
- Verified mdocs workflow and tool integration
- Agent autonomy over mdocs knowledge confirmed working

## Artifacts
- `opencode.json` configuration file

## Acceptance Criteria
- `npm install` completes without errors
- `opencode.json` contains plugin and agent configuration
- `mdocs_status` returns workflow state and active initiatives
