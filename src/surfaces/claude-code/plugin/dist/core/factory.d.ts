import { AuditLog } from './audit';
import { MdocsCommandRegistry } from './commands/registry';
import { MdocsCompatibilityConfig, MdocsContract } from './contract';
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
export declare function createMdocsCore(projectDir: string, options?: MdocsCoreOptions): MdocsCore;
