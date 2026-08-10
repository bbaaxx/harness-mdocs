import { InitiativeManager } from '../managers/initiative';
export declare function today(): string;
export declare function slugify(value: string): string;
export declare function findInitiativeFilename(mdocsRoot: string, initiatives: InitiativeManager, id: string): string | null;
/**
 * Return a copy of `args` with known snake_case keys mapped to their
 * camelCase equivalent. A camelCase key already present wins over its
 * snake_case alias; the snake_case spelling is always removed.
 */
export declare function normalizeCommandKeys(args: Record<string, any>): Record<string, any>;
