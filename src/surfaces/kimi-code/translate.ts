/**
 * Pure Kimi Code <-> core translation. No fs, no core imports.
 * Unit-testable in isolation.
 *
 * Why this exists: core WorkflowEngine.canExecuteTool / isMdocsOperation were
 * written for OpenCode conventions (lowercase tool names, camelCase args).
 * Kimi Code emits PascalCase tool names (per the built-in tools reference)
 * and snake_case tool_input keys on hook stdin payloads. Without translation
 * the gate silently never blocks — same failure mode the Claude Code surface
 * documents in its translate.ts.
 *
 * Kimi Code hook payloads (verified against the hooks documentation):
 *   { hook_event_name, tool_name, tool_input, tool_response, cwd,
 *     session_id, prompt, source, model, profile }
 */

/** Kimi Code PascalCase tool name -> core lowercase name. */
const TOOL_NAME_MAP: Record<string, string> = {
  Read: 'read',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list',
  List: 'list',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  // Subagent dispatch tools. Both map to a non-gated pass-through; mapping
  // them keeps audit matching robust across Kimi Code versions.
  Agent: 'task',
  AgentSwarm: 'task',
  Task: 'task'
};

/** Kimi Code tool_input key -> core toolArgs key. */
const ARG_KEY_MAP: Record<string, string> = {
  file_path: 'filePath',
  notebook_path: 'filePath',
  path: 'path',
  pattern: 'pattern',
  command: 'command',
  old_string: 'oldString',
  new_string: 'newString',
  replace_all: 'replaceAll'
};

export function translateToolName(kimiToolName: string): string {
  if (kimiToolName in TOOL_NAME_MAP) return TOOL_NAME_MAP[kimiToolName];
  // Safe default: lowercase verbatim. Unknown tools fall through to the
  // engine's final `return true`, matching "allow unless explicitly gated".
  return kimiToolName.toLowerCase();
}

export function translateArgs(toolInput: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!toolInput) return out;
  for (const [key, value] of Object.entries(toolInput)) {
    const mapped = ARG_KEY_MAP[key] ?? key; // preserve unknown keys verbatim
    // First mapped write wins so an explicit core-shaped key isn't clobbered.
    if (!(mapped in out)) out[mapped] = value;
  }
  return out;
}

export interface KimiHookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
  prompt?: string;
  source?: string;
  model?: string;
  profile?: string;
}

/**
 * Parse raw stdin into a payload. Returns null on malformed input so callers
 * can FAIL OPEN (never block the user's tool because the translator choked).
 */
export function parseHookStdin(raw: string): KimiHookPayload | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as KimiHookPayload;
    return null;
  } catch {
    return null;
  }
}

/** Convenience: translate a full payload into core (toolName, toolArgs). */
export function toCore(payload: KimiHookPayload): { toolName: string; toolArgs: Record<string, unknown> } {
  return {
    toolName: translateToolName(payload.tool_name ?? ''),
    toolArgs: translateArgs(payload.tool_input)
  };
}
