import * as path from 'path';
import { AuditLog } from './audit';
import { MdocsCommandRegistry } from './commands/registry';
import { MdocsCompatibilityConfig, detectMdocsContract } from './contract';
import { MdocsLifecycleOptions, MdocsLifecycleService } from './lifecycle';
import { InitiativeManager } from './managers/initiative';
import { MdocsManager } from './managers/mdocs';
import { WikiManager, WikiManagerOptions } from './managers/wiki';
import { MdocsLinter } from './validation/linter';
import { SearchEngine } from './search';
import { SubagentAssembler } from './subagent';
import { WorkflowEngine } from './workflow/engine';

export interface MdocsCoreOptions {
  mdocsDirName?: string;
  standaloneCategories?: string[];
  compatibility?: MdocsCompatibilityConfig;
  wiki?: WikiManagerOptions;
  bootstrap?: MdocsLifecycleOptions;
}

export interface MdocsCore {
  projectDir: string;
  mdocsRoot: string;
  managers: {
    mdocs: MdocsManager;
    initiatives: InitiativeManager;
    wiki: WikiManager;
    workflow: WorkflowEngine;
    search: SearchEngine;
    audit: AuditLog;
    linter: MdocsLinter;
    dispatch: SubagentAssembler;
  };
  lifecycle: MdocsLifecycleService;
  commands: MdocsCommandRegistry;
}

export function createMdocsCore(projectDir: string, options: MdocsCoreOptions = {}): MdocsCore {
  const mdocsRoot = path.join(projectDir, options.mdocsDirName || 'mdocs');
  const compatibility = { ...(options.wiki?.compatibility || {}), ...(options.compatibility || {}) };
  const contract = detectMdocsContract(mdocsRoot, compatibility);
  const mdocs = new MdocsManager(mdocsRoot, compatibility);
  const initiatives = new InitiativeManager(mdocsRoot, { compatibility });
  const wiki = new WikiManager(mdocsRoot, {
    standaloneCategories: options.wiki?.standaloneCategories ?? options.standaloneCategories,
    compatibility
  });
  const workflow = new WorkflowEngine(mdocsRoot, {
    enforcementMode: contract.enforcementMode,
    idle: contract.idle
  });
  const search = new SearchEngine(mdocsRoot);
  const audit = new AuditLog(mdocsRoot);
  const linter = new MdocsLinter(mdocsRoot);
  const dispatch = new SubagentAssembler();
  const lifecycle = new MdocsLifecycleService(mdocs, initiatives, options.bootstrap);
  const commands = new MdocsCommandRegistry({
    mdocsRoot,
    mdocs,
    initiatives,
    wiki,
    workflow,
    search,
    audit,
    linter,
    dispatch
  });

  return {
    projectDir,
    mdocsRoot,
    managers: { mdocs, initiatives, wiki, workflow, search, audit, linter, dispatch },
    lifecycle,
    commands
  };
}
