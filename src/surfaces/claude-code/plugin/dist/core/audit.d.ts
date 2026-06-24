import { AuditEvent } from './types';
export declare class AuditLog {
    private logPath;
    constructor(baseDir: string);
    private rotateIfNeeded;
    append(event: AuditEvent): void;
    query(options?: {
        startDate?: string;
        endDate?: string;
        type?: string;
        initiativeId?: string;
        limit?: number;
    }): AuditEvent[];
    summarize(initiativeId: string): AuditEvent[];
}
