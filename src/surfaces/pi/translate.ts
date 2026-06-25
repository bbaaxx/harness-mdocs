/**
 * pi <-> core translation.
 *
 * pi built-in tool names are already lowercase (`read`, `write`, `edit`,
 * `bash`, `grep`, `find`, `ls`) and argument keys align with core
 * WorkflowEngine.isMdocsOperation checks:
 *   - read:  { path, offset?, limit? }
 *   - write: { path, content }
 *   - edit:  { path, oldText, newText? }
 *   - bash:  { command, timeout? }
 * Core already inspects `args.path`, `args.pattern`, and `args.command`, so no
 * translation layer is required for built-ins. This file is a typed
 * identity/passthrough kept for symmetry with the Claude Code surface and as a
 * future seam if a pi tool diverges from core conventions.
 */

export interface PiToolCallEvent {
  toolName: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
}

export function translateToolName(piToolName: string): string {
  // pi built-ins are already lowercase; pass through verbatim. Unknown tools
  // fall through to the engine's final `return true` ("allow unless gated").
  return piToolName;
}

export function translateArgs(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  // pi args already use the core camelCase keys (path, content, command,
  // pattern). Return as-is. If a future pi tool emits snake_case keys, map
  // them here.
  return input;
}

export function toCore(event: PiToolCallEvent): { toolName: string; toolArgs: Record<string, unknown> } {
  return {
    toolName: translateToolName(event.toolName ?? ''),
    toolArgs: translateArgs(event.input)
  };
}
