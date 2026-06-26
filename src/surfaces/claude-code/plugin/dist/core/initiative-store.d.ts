import { MdocsContract } from './contract';
import { Initiative, Status } from './types';
export declare function normalizeInitiativeStatus(status: string | undefined): Status;
export interface InitiativeRecord {
    key: string;
    filePath: string;
    sourceKind: 'flat-file' | 'directory-status';
    archived: boolean;
    rawFrontmatter: Record<string, any>;
    initiative: Initiative;
}
export declare class InitiativeStore {
    private readonly baseDir;
    private readonly contract;
    private initiativesDir;
    constructor(baseDir: string, contract: MdocsContract);
    list(options?: {
        includeArchived?: boolean;
    }): InitiativeRecord[];
    read(key: string): InitiativeRecord | null;
    create(initiative: Initiative): {
        key: string;
        dirPath: string;
        filePath: string;
        initiative: Initiative;
    };
    update(key: string, initiative: Initiative, progressNote?: string): {
        key: string;
        dirPath: string;
        filePath: string;
        initiative: Initiative;
    };
    delete(key: string): void;
    markDone(key: string, timestamp?: Date): {
        key: string;
        filePath: string;
        initiative: Initiative;
    };
    archive(key: string): {
        archivedFilename: string;
        sourcePath: string;
        targetPath: string;
    };
    findById(id: string, options?: {
        includeArchived?: boolean;
    }): InitiativeRecord | null;
    findByQuery(query: string): InitiativeRecord | null;
    private listFlatRecords;
    private listDirectoryRecords;
    private parseRecord;
    private formatStatusFile;
    private frontmatterUpdates;
    private safeDirectoryKey;
    private updateStatusFile;
    private appendProgressNote;
}
