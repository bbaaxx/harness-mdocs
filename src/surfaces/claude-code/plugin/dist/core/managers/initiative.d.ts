import { MdocsCompatibilityConfig } from '../contract';
import { Initiative } from '../types';
export interface InitiativeManagerOptions {
    compatibility?: MdocsCompatibilityConfig;
}
export declare class InitiativeManager {
    private dir;
    private contract;
    private store;
    constructor(baseDir: string, options?: InitiativeManagerOptions);
    private slugify;
    private formatFileName;
    private sanitizeFileName;
    private toFrontmatter;
    private initiativeFiles;
    private validationFiles;
    private markdownDestinations;
    private listedIndexFiles;
    private assertUniqueId;
    assertWriteSupported(operation: string): void;
    create(initiative: Initiative): string;
    read(fileName: string): Initiative | null;
    private parseInitiative;
    update(fileName: string, initiative: Initiative): string;
    markDone(fileName: string): {
        filePath: string;
        filename: string;
        initiative: Initiative;
    };
    delete(fileName: string): void;
    syncIndex(): string;
    archive(fileName: string): {
        archivedFilename: string;
        archiveIndex: string;
    };
    /**
     * Add one wiki ref to the initiative's related_wiki. Under directory
     * metadata-only mode this is a surgical frontmatter-array mutation (body
     * and unrelated frontmatter preserved byte-for-byte, key created if
     * absent); every other mode routes through the standard full update.
     * Idempotent: returns false when the ref was already linked.
     */
    addRelatedWikiLink(fileName: string, ref: string): boolean;
    /**
     * Remove one wiki ref from the initiative's related_wiki. Mirrors
     * addRelatedWikiLink; used to roll back failed bidirectional links.
     * Idempotent: returns false when the ref was not linked.
     */
    removeRelatedWikiLink(fileName: string, ref: string): boolean;
    findById(id: string): Initiative | null;
    findKeyById(id: string): string | null;
    findByQuery(query: string): {
        initiative: Initiative;
        key: string;
    } | null;
    list(includeArchived?: boolean): Initiative[];
    findRelated(queryTags: string[]): Initiative[];
    findBlocked(): Initiative[];
    findOverdue(): Initiative[];
    listByPriority(): Initiative[];
    validate(): {
        valid: boolean;
        errors: string[];
        warnings: string[];
    };
    private statusesEquivalent;
    checkConsistency(): {
        consistent: boolean;
        missing: string[];
        orphans: string[];
        stale: boolean;
    };
    private listAll;
    private updateArchiveIndex;
    private writeIndexMeta;
    private updateIndex;
}
