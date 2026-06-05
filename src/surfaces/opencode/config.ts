import * as fs from 'fs';
import * as path from 'path';
import { MdocsCore } from '../../core';

function loadAgentPrompt(agentPath: string) {
  const content = fs.readFileSync(agentPath, 'utf8');
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

export function applyOpencodeConfig(core: MdocsCore, cfg: any) {
  try {
    const agentPath = path.resolve(__dirname, '../../../agents/mdocs-orchestrator.md');
    if (!cfg.agent) cfg.agent = {};
    if (!cfg.agent['mdocs-orchestrator']) {
      cfg.agent['mdocs-orchestrator'] = {
        description: 'Orchestrates work using the mdocs initiative/wiki workflow.',
        mode: 'primary',
        permission: {
          read: 'allow',
          glob: 'allow',
          grep: 'allow',
          list: 'allow',
          edit: 'allow',
          write: 'allow',
          bash: 'allow'
        },
        prompt: fs.existsSync(agentPath) ? loadAgentPrompt(agentPath) : ''
      };
    }

    const skillsPath = path.resolve(__dirname, '../../../skills');
    if (fs.existsSync(skillsPath)) {
      if (!cfg.skills) cfg.skills = {};
      if (!cfg.skills.paths) cfg.skills.paths = [];
      if (!Array.isArray(cfg.skills.paths)) cfg.skills.paths = [cfg.skills.paths];
      const alreadyAdded = cfg.skills.paths.some(
        (entry: string) =>
          entry === skillsPath ||
          entry.includes('opencode-mdocs/skills') ||
          entry.includes('opencode-mdocs\\skills') ||
          entry.includes('harness-mdocs/skills') ||
          entry.includes('harness-mdocs\\skills')
      );
      if (!alreadyAdded) cfg.skills.paths.push(skillsPath);
    }
  } catch (error) {
    console.error('[mdocs] Config registration skipped:', error);
  }

  core.lifecycle.ensureInitialized();
}
