import { InitiativeManager } from '../managers/initiative';
export declare function today(): string;
export declare function slugify(value: string): string;
export declare function findInitiativeFilename(mdocsRoot: string, initiatives: InitiativeManager, id: string): string | null;
