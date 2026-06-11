import { createMdocsCore, MdocsCore } from '../../core';
import { createClaudeCodeHooks } from './hooks';

export interface MdocsClaudeCodeOptions {
  standaloneCategories?: string[];
}

/**
 * Surface runtime for Claude Code. Wraps createMdocsCore and exposes the
 * translated hook handlers. Mirrors the loose codex/opencode adapter style.
 *
 * The MCP server (mcp-server.ts) constructs its own core per tool call and is
 * not threaded through this adapter; this adapter is for programmatic/hook use.
 */
export function createClaudeCodeAdapter(projectDir: string, options: MdocsClaudeCodeOptions = {}) {
  const core: MdocsCore = createMdocsCore(projectDir, {
    standaloneCategories: options.standaloneCategories,
    bootstrap: {
      installInitiativeTitle: 'Install and Configure claude-code-mdocs'
    }
  });
  return {
    core,
    ...createClaudeCodeHooks(core)
  };
}
