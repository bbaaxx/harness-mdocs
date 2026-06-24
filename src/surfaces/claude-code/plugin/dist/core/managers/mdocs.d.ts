import { MdocsCompatibilityConfig } from '../contract';
export declare class MdocsManager {
    private baseDir;
    private contract;
    constructor(baseDir: string, compatibility?: MdocsCompatibilityConfig);
    init(): void;
    private writeIndex;
    exists(): boolean;
    private hasDirectoryInitiative;
    private getMetaPath;
    writeIndexMeta(): void;
    readIndexMeta(): {
        lastSync: string | null;
    };
}
