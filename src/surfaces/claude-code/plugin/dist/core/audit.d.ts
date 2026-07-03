import { AuditEvent } from './types';
export type AuditLevel = 'full' | 'metadata' | 'off';
export interface AuditLogOptions {
    level?: AuditLevel;
    maxBytes?: number;
    maxBackups?: number;
}
export declare class AuditLog {
    private logPath;
    private readonly level;
    private readonly maxBytes;
    private readonly maxBackups;
    constructor(baseDir: string, options?: AuditLogOptions);
    private rotateIfNeeded;
    append(event: AuditEvent): void;
    private metadataOnly;
    query(options?: {
        startDate?: string;
        endDate?: string;
        type?: string;
        initiativeId?: string;
        limit?: number;
    }): AuditEvent[];
    summarize(initiativeId: string): AuditEvent[];
}
