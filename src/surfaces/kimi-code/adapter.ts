import { createMdocsCore, MdocsCore } from '../../core';
import { createKimiCodeHooks } from './hooks';

export interface MdocsKimiCodeOptions {
  standaloneCategories?: string[];
}

/**
 * Surface runtime for Kimi Code. Wraps createMdocsCore and exposes the
 * translated hook handlers. Mirrors the Claude Code adapter style.
 *
 * The MCP server (mcp-server.ts) reuses the shared registration from the
 * Claude Code surface and is not threaded through this adapter; this adapter
 * is for programmatic/hook use.
 */
export function createKimiCodeAdapter(projectDir: string, options: MdocsKimiCodeOptions = {}) {
  const core: MdocsCore = createMdocsCore(projectDir, {
    standaloneCategories: options.standaloneCategories,
    bootstrap: {
      installInitiativeTitle: 'Install and Configure kimi-code-mdocs'
    }
  });
  return {
    core,
    ...createKimiCodeHooks(core)
  };
}
