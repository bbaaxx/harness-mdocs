import * as path from 'path';
import { AuditLog } from './audit';
import { MdocsCommandRegistry } from './commands/registry';
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
  const mdocs = new MdocsManager(mdocsRoot);
  const initiatives = new InitiativeManager(mdocsRoot);
  const wiki = new WikiManager(mdocsRoot, {
    standaloneCategories: options.wiki?.standaloneCategories ?? options.standaloneCategories
  });
  const workflow = new WorkflowEngine(mdocsRoot);
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
