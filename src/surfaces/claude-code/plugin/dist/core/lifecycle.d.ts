import { InitiativeManager } from './managers/initiative';
import { MdocsManager } from './managers/mdocs';
export interface MdocsLifecycleOptions {
    createInstallInitiative?: boolean;
    installInitiativeTitle?: string;
    installInitiativeId?: string;
    owner?: string;
    tags?: string[];
}
export interface MdocsLifecycleResult {
    initialized: boolean;
    bootstrapInitiativeCreated: boolean;
}
export declare class MdocsLifecycleService {
    private readonly mdocs;
    private readonly initiatives;
    private readonly options;
    constructor(mdocs: MdocsManager, initiatives: InitiativeManager, options?: MdocsLifecycleOptions);
    ensureInitialized(): MdocsLifecycleResult;
}
