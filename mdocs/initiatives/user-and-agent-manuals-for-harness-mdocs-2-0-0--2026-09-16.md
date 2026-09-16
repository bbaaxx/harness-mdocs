---
id: "user-and-agent-manuals-for-harness-mdocs-2-0-0"
title: "User and agent manuals for harness-mdocs 2.0.0"
status: "done"
created: "2026-09-16"
updated: "2026-09-16"
owner: ""
tags: ["docs","2.0.0","manuals"]
related_wiki: ["docs/user-manual-2-0-0","docs/agent-manual-2-0-0"]
priority: "medium"
---

## Objective
Write two manuals that close the docs gap for harness-mdocs 2.0.0: (1) USER MANUAL — for humans installing and operating mdocs-backed projects: install per surface (opencode, claude-code, codex, pi), what initiatives/wiki are, the workflow steps and why gating exists, CLI reference, config (.mdocs.json, enforcement modes, idle strictness), upgrade notes (2.0.0 = zero breaking changes per wiki release/v2-0-0-migration-matrix), troubleshooting. (2) AGENT MANUAL — for AI agents operating inside an mdocs session: the 13-tool surface, workflow contract (UNDERSTAND..COMPLETE, gate behavior, reset/advance semantics incl. create-vs-resume activation design), how to dispatch subagents with mdocs_dispatch, progress/wiki hygiene, audit trail awareness. Both grounded in shipped 2.0.0 behavior, not aspirational features.

## Plan


## Progress Log
- [2026-09-16T05:54:20.276Z] Created initiative via mdocs command
- [2026-09-16T06:03:40.506Z] mdocs_advance executed at step UNDERSTAND
- [2026-09-16T06:03:40.558Z] glob executed at step UNDERSTAND
- [2026-09-16T06:03:48.146Z] read executed at step UNDERSTAND
- [2026-09-16T06:03:57.342Z] mdocs_advance executed at step DISCOVER
- [2026-09-16T06:03:57.495Z] mdocs_search executed at step DISCOVER
- [2026-09-16T06:04:10.928Z] mdocs_advance executed at step CONTEXT
- [2026-09-16T06:04:10.972Z] read executed at step CONTEXT
- [2026-09-16T06:04:11.002Z] read executed at step CONTEXT
- [2026-09-16T06:04:23.064Z] read executed at step CONTEXT
- [2026-09-16T06:04:23.090Z] read executed at step CONTEXT
- [2026-09-16T06:04:36.342Z] grep executed at step CONTEXT
- [2026-09-16T06:04:36.361Z] grep executed at step CONTEXT
- [2026-09-16T06:04:49.758Z] mdocs_advance executed at step PLAN
- [2026-09-16T06:05:06.576Z] edit executed at step PLAN
- [2026-09-16T06:05:12.882Z] mdocs_advance executed at step EXECUTE
- [2026-09-16T06:05:13.262Z] mdocs_dispatch executed at step EXECUTE
- [2026-09-16T06:06:10.804Z] read executed at step EXECUTE
- [2026-09-16T06:06:10.836Z] read executed at step EXECUTE
- [2026-09-16T06:06:10.959Z] bash executed at step EXECUTE
- [2026-09-16T06:06:25.235Z] bash executed at step EXECUTE
- [2026-09-16T06:06:25.260Z] read executed at step EXECUTE
- [2026-09-16T06:06:25.281Z] read executed at step EXECUTE
- [2026-09-16T06:06:29.108Z] mdocs_status executed at step EXECUTE
- [2026-09-16T06:06:29.165Z] read executed at step EXECUTE
- [2026-09-16T06:06:29.181Z] read executed at step EXECUTE
- [2026-09-16T06:06:29.198Z] read executed at step EXECUTE
- [2026-09-16T06:06:37.394Z] read executed at step EXECUTE
- [2026-09-16T06:06:37.435Z] read executed at step EXECUTE
- [2026-09-16T06:06:52.439Z] read executed at step EXECUTE
- [2026-09-16T06:06:52.460Z] read executed at step EXECUTE
- [2026-09-16T06:06:52.478Z] bash executed at step EXECUTE
- [2026-09-16T06:06:57.777Z] read executed at step EXECUTE
- [2026-09-16T06:06:57.797Z] read executed at step EXECUTE
- [2026-09-16T06:06:57.821Z] read executed at step EXECUTE
- [2026-09-16T06:07:10.926Z] read executed at step EXECUTE
- [2026-09-16T06:07:10.946Z] read executed at step EXECUTE
- [2026-09-16T06:07:11.125Z] read executed at step EXECUTE
- [2026-09-16T06:07:11.144Z] read executed at step EXECUTE
- [2026-09-16T06:07:15.829Z] bash executed at step EXECUTE
- [2026-09-16T06:07:22.202Z] read executed at step EXECUTE
- [2026-09-16T06:07:31.794Z] bash executed at step EXECUTE
- [2026-09-16T06:07:36.035Z] bash executed at step EXECUTE
- [2026-09-16T06:07:43.177Z] bash executed at step EXECUTE
- [2026-09-16T06:07:51.768Z] bash executed at step EXECUTE
- [2026-09-16T06:09:15.303Z] write executed at step EXECUTE
- [2026-09-16T06:09:38.776Z] write executed at step EXECUTE
- [2026-09-16T06:09:41.321Z] bash executed at step EXECUTE
- [2026-09-16T06:09:48.589Z] bash executed at step EXECUTE
- [2026-09-16T06:10:13.278Z] task executed at step EXECUTE
- [2026-09-16T06:10:28.129Z] edit executed at step EXECUTE
- [2026-09-16T06:10:37.773Z] bash executed at step EXECUTE
- [2026-09-16T06:11:17.040Z] edit executed at step EXECUTE
- [2026-09-16T06:11:31.654Z] bash executed at step EXECUTE
- [2026-09-16T06:11:42.180Z] bash executed at step EXECUTE
- [2026-09-16T06:12:02.628Z] task executed at step EXECUTE
- [2026-09-16T06:12:12.127Z] mdocs_advance executed at step VERIFY
- [2026-09-16T06:12:12.177Z] bash executed at step VERIFY
- [2026-09-16T06:12:25.885Z] grep executed at step VERIFY
- [2026-09-16T06:12:25.903Z] grep executed at step VERIFY
- [2026-09-16T06:12:39.838Z] read executed at step VERIFY
- [2026-09-16T06:12:52.409Z] grep executed at step VERIFY
- [2026-09-16T06:13:05.346Z] mdocs_validate executed at step VERIFY
- [2026-09-16T06:13:30.441Z] mdocs_advance executed at step REPORT
- [2026-09-16T06:13:30.472Z] mdocs executed at step REPORT
- [2026-09-16T06:13:30.498Z] mdocs executed at step REPORT
- [2026-09-16T06:13:47.838Z] edit executed at step REPORT
- [2026-09-16T06:13:47.860Z] edit executed at step REPORT
- Wrote docs/user-manual.md (459 lines) + docs/agent-manual.md (253 lines) via two parallel subagents; claims verified against src (CLI commands, registry subcommands, STEPS, canExecuteTool gate rules, MDOCS_* env keys, parity test 13-tool list). mdocs_validate clean. Wiki entries docs/user-manual-2-0-0 + docs/agent-manual-2-0-0 created and linked in initiative related_wiki; README Documentation section added.
- [2026-09-16T06:13:56.333Z] mdocs executed at step REPORT
- [2026-09-16T06:14:04.723Z] mdocs_validate executed at step REPORT
- [2026-09-16T06:14:16.374Z] bash executed at step REPORT
- [2026-09-16T06:14:21.493Z] read executed at step REPORT
- [2026-09-16T06:14:32.061Z] edit executed at step REPORT
- [2026-09-16T06:14:32.218Z] edit executed at step REPORT
- [2026-09-16T06:14:40.825Z] mdocs_validate executed at step REPORT
- [2026-09-16T06:14:54.935Z] mdocs_advance executed at step COMPLETE
- [2026-09-16T08:44:32.042Z] Marked done via mdocs command

## Artifacts
