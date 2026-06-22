---
id: "fix-claude-code-install-template-and-cli-help"
title: "Fix Claude Code manual-install template + CLI help"
status: "done"
created: "2026-06-22"
updated: "2026-06-22"
owner: ""
tags: ["claude-code","surface","docs","mcp","cli"]
related_wiki: []
priority: "medium"
next_action: "Mark done"
---

## Objective
The Claude Code manual-install recipe silently disconnects MCP. src/surfaces/claude-code/assets/templates/settings-patch.json puts mcpServers inside .claude/settings.json, but Claude Code reads project-scoped MCP from .mcp.json (root), so the server never loads. Verified during project-scope dogfooding: server handshake works, but claude mcp list showed no mdocs entry until MCP was moved to .mcp.json. Split the template: keep hooks in settings.json, move MCP to a companion .mcp.json template. Also fix CLI --help: dist/cli/index.js usage line omits the mcp subcommand (server works, just undocumented).

## Plan
- [ ] Edit settings-patch.json: drop mcpServers block, keep hooks only
- [ ] Add companion template .mcp.json (or document both files) under assets/templates
- [ ] Update README Claude Code manual-install section to reference .mcp.json for MCP server
- [ ] Add 'mcp' to the usage string in src/cli/index.ts
- [ ] Rebuild dist, verify --help lists mcp and handshake still passes
- [ ] Run npm run mdocs:validate and pack:check

## Progress Log
- [2026-06-22T20:49:50.121Z] Created initiative via mdocs command
- [2026-06-22T21:18:30.667Z] bash executed at step PLAN
- [2026-06-22T21:18:45.999Z] bash executed at step PLAN
- [2026-06-22T21:19:29.130Z] bash executed at step PLAN
- [2026-06-22T21:19:53.628Z] write executed at step PLAN
- [2026-06-22T21:20:13.722Z] write executed at step PLAN
- [2026-06-22T21:20:28.155Z] edit executed at step PLAN
- [2026-06-22T21:20:39.744Z] edit executed at step PLAN
- [2026-06-22T21:20:53.563Z] edit executed at step PLAN
- [2026-06-22T21:21:24.190Z] bash executed at step VERIFY
- [2026-06-22T21:21:44.263Z] bash executed at step VERIFY
- [2026-06-22T21:21:55.896Z] bash executed at step VERIFY
- [2026-06-22T21:22:15.411Z] bash executed at step VERIFY
- [2026-06-22T21:23:29.750Z] bash executed at step COMPLETE
- Split manual-install config: settings-patch.json now hooks-only, new mcp.json template holds the MCP server. README manual-install section rewritten to use .mcp.json (MCP) + .claude/settings.json (hooks) as two files with a restart note. CLI usage string now lists mcp and step subcommands. Plugin manifest (plugin.json) untouched — its bundled mcpServers+hooks is correct for the plugin route. Added usage regression test. Synced plugin mdocs-workflow skill copy with assets. 293 tests pass, validate clean. Wiki: architecture/claude-code-project-mcp-location.
- [2026-06-22T21:23:42.209Z] Marked done via mdocs command

## Artifacts
