import { createMdocsCore } from '../../core';
import { applyOpencodeConfig } from './config';
import { createOpencodeHooks } from './hooks';
import { createOpencodeTools } from './tools';

export interface MdocsOpencodeOptions {
  standaloneCategories?: string[];
}

export function createOpencodeAdapter(projectDir: string, options: MdocsOpencodeOptions = {}) {
  const core = createMdocsCore(projectDir, {
    standaloneCategories: options.standaloneCategories,
    bootstrap: {
      installInitiativeTitle: 'Install and Configure opencode-mdocs'
    }
  });
  return {
    config: (cfg: any) => applyOpencodeConfig(core, cfg),
    ...createOpencodeHooks(core),
    tool: createOpencodeTools(core)
  };
}
