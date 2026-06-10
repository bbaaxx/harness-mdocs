# Codex V1

Codex v1 packages mdocs as a Codex plugin with skills and CLI-backed command access.

The v1 surface supports:

- mdocs workflow skill
- mdocs initiative skill
- mdocs orchestrator skill
- CLI access through `mdocs`
- shared core file formats

The v1 surface does not support:

- host-level write blocking
- destructive command blocking
- automatic audit logging for every Codex tool call
- permission hook integration
- native Codex command tools or MCP command tools

Use `mdocs validate` before claiming mdocs memory is clean.
