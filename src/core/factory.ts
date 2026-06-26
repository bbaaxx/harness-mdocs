import * as path from 'path';
import { AuditLog } from './audit';
import { MdocsCommandRegistry } from './commands/registry';
import { MdocsCompatibilityConfig, MdocsContract, detectMdocsContract } from './contract';
import { loadProjectConfig } from './config';
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
  /**
   * The resolved mdocs contract: detected layout (initiative/wiki modes,
   * archive dir, index owner) plus compatibility flags
   * (`initiativeRecordMode`, `enforcementMode`, `idle`). Exposed so surfaces
   * and consumers can branch on resolved behavior without re-detecting.
   */
  contract: MdocsContract;
}

export function createMdocsCore(projectDir: string, options: MdocsCoreOptions = {}): MdocsCore {
  // Load the opt-in `.mdocs.json` from the preliminary mdocs root (default dir
  // name, or an explicit override) and merge so explicit options win over
  // file, file over built-in defaults. Recompute the root from the merged dir
  // name in case the file redeclares it.
  const preliminaryRoot = path.join(projectDir, options.mdocsDirName || 'mdocs');
  const fileConfig = loadProjectConfig(preliminaryRoot);
  const merged = mergeOptions(fileConfig, options);
  const mdocsRoot = path.join(projectDir, merged.mdocsDirName || 'mdocs');
  const compatibility = { ...(merged.wiki?.compatibility || {}), ...(merged.compatibility || {}) };
  const contract = detectMdocsContract(mdocsRoot, compatibility);
  const mdocs = new MdocsManager(mdocsRoot, compatibility);
  const initiatives = new InitiativeManager(mdocsRoot, { compatibility });
  const wiki = new WikiManager(mdocsRoot, {
    standaloneCategories: merged.wiki?.standaloneCategories ?? merged.standaloneCategories,
    compatibility
  });
  const workflow = new WorkflowEngine(mdocsRoot, {
    enforcementMode: contract.enforcementMode,
    idle: contract.idle
  });
  const search = new SearchEngine(mdocsRoot);
  const audit = new AuditLog(mdocsRoot);
  const linter = new MdocsLinter(mdocsRoot, { initiativeRecordMode: contract.initiativeRecordMode });
  const dispatch = new SubagentAssembler();
  const lifecycle = new MdocsLifecycleService(mdocs, initiatives, merged.bootstrap);
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
    commands,
    contract
  };
}

/**
 * Merge a file-loaded config with explicit options. Explicit options win at
 * the top level; the nested `compatibility` and `wiki` objects merge key-level
 * so a file can set e.g. `enforcementMode` while an explicit option adds
 * `initiativeRecordMode`, each without clobbering the other.
 */
function mergeOptions(file: MdocsCoreOptions, explicit: MdocsCoreOptions): MdocsCoreOptions {
  const merged: MdocsCoreOptions = { ...file, ...explicit };
  if (file.compatibility || explicit.compatibility) {
    merged.compatibility = { ...(file.compatibility || {}), ...(explicit.compatibility || {}) };
  }
  if (file.wiki || explicit.wiki) {
    merged.wiki = { ...(file.wiki || {}), ...(explicit.wiki || {}) };
  }
  return merged;
}
