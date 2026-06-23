---
name: mdocs-orchestrator
description: Use as the primary mdocs workflow guide for Codex sessions that need durable initiative and wiki memory.
---

# Mdocs Orchestrator For Codex

Start by checking for existing work:

```bash
mdocs status
```

If there is no active initiative and the user wants durable tracking, create one:

```bash
mdocs command initiative.create --json '{"title":"Work title","objective":"Clear objective","plan":["Understand request","Inspect code","Implement","Verify"]}'
```

During work, keep `next_action`, `blockers`, and `handoff_summary` current through `initiative.update`.

Before handing work to another agent or thread, assemble context when command support exists. If dispatch command support is not available in the current CLI build, read the active initiative plus related wiki entries directly.

Before marking work complete:

1. Run project verification commands.
2. Run `mdocs validate`.
3. Write or update at least one stable wiki learning for completed initiatives.
4. Mark the initiative done with `mdocs command initiative.done --json '{"id":"initiative-id"}'`.

Codex v1 follows workflow gates by instruction. It does not block host file edits or shell commands. `Bash` is audited but not gated by content.
