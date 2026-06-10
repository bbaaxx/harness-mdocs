# Opencode Parity

The opencode surface preserves the current `opencode-mdocs` behavior:

- config hook registers the `mdocs-orchestrator` agent
- config hook registers bundled skills
- first run initializes `./mdocs`
- first run creates the bootstrap install initiative
- custom tool names remain available
- tool execution hooks enforce workflow gates
- permission hook returns allow or ask from core workflow decisions
- event and tool hooks append audit events and progress log entries
- event hook accepts direct events, OpenCode event envelopes, and malformed payloads without crashing
