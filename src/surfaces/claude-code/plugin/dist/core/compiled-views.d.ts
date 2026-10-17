import { MdocsContract } from './contract';
import { InitiativeManager } from './managers/initiative';
import { WikiManager } from './managers/wiki';
export type CompiledViewRegistration = {
    type: 'initiative';
    id: string;
} | {
    type: 'wiki';
    ref: string;
} | {
    type: 'overview';
    initiativeId: string;
};
/** Explicit, opt-in, per-row registration. Curated rows remain user-owned. */
export declare class CompiledViewRegistrar {
    private readonly root;
    private readonly contract;
    private readonly initiatives;
    private readonly wiki;
    constructor(root: string, contract: MdocsContract, initiatives: InitiativeManager, wiki: WikiManager);
    register(input: unknown): any;
    private row;
    private apply;
}
