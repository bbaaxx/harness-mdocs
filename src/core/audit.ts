import * as fs from 'fs';
import * as path from 'path';
import { AuditEvent, StepName } from './types';

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUPS = 3;

export type AuditLevel = 'full' | 'metadata' | 'off';

export interface AuditLogOptions {
  level?: AuditLevel;
  maxBytes?: number;
  maxBackups?: number;
}

export class AuditLog {
  private logPath: string;
  private readonly level: AuditLevel;
  private readonly maxBytes: number;
  private readonly maxBackups: number;

  constructor(baseDir: string, options: AuditLogOptions = {}) {
    this.logPath = path.join(baseDir, 'audit.log');
    this.level = envAuditLevel() ?? options.level ?? 'full';
    this.maxBytes = positiveInt(process.env.MDOCS_AUDIT_MAX_BYTES) ?? options.maxBytes ?? MAX_LOG_SIZE;
    this.maxBackups = positiveInt(process.env.MDOCS_AUDIT_MAX_BACKUPS) ?? options.maxBackups ?? MAX_BACKUPS;
    // Ensure directory exists
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.logPath)) return;
    const stats = fs.statSync(this.logPath);
    if (stats.size < this.maxBytes) return;

    // Remove oldest backup if at max
    if (this.maxBackups <= 0) {
      fs.unlinkSync(this.logPath);
      return;
    }
    const oldestBackup = `${this.logPath}.${this.maxBackups}`;
    if (fs.existsSync(oldestBackup)) {
      fs.unlinkSync(oldestBackup);
    }

    // Shift existing backups up
    for (let i = this.maxBackups - 1; i >= 1; i--) {
      const backupPath = `${this.logPath}.${i}`;
      const nextPath = `${this.logPath}.${i + 1}`;
      if (fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, nextPath);
      }
    }

    // Rename current log to .1
    fs.renameSync(this.logPath, `${this.logPath}.1`);
  }

  append(event: AuditEvent): void {
    if (this.level === 'off') return;
    this.rotateIfNeeded();
    const line = JSON.stringify(this.level === 'metadata' ? this.metadataOnly(event) : event) + '\n';
    fs.appendFileSync(this.logPath, line, 'utf8');
  }

  private metadataOnly(event: AuditEvent): AuditEvent {
    const details = event.details || {};
    return {
      ...event,
      details: {
        toolName: details.toolName,
        eventType: details.eventType,
        operation: details.operation,
        command: details.command
      }
    };
  }

  query(options: {
    startDate?: string;
    endDate?: string;
    type?: string;
    initiativeId?: string;
    limit?: number;
  } = {}): AuditEvent[] {
    if (!fs.existsSync(this.logPath)) return [];

    const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
    const events: AuditEvent[] = [];

    for (const line of lines) {
      try {
        const event: AuditEvent = JSON.parse(line);
        if (options.type && event.type !== options.type) continue;
        if (options.initiativeId && event.initiativeId !== options.initiativeId) continue;
        if (options.startDate && event.timestamp < options.startDate) continue;
        if (options.endDate && event.timestamp > options.endDate) continue;
        events.push(event);
      } catch {
        // Skip malformed lines
      }
    }

    if (options.limit) {
      return events.slice(-options.limit);
    }
    return events;
  }

  summarize(initiativeId: string): AuditEvent[] {
    return this.query({ initiativeId });
  }
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function envAuditLevel(): AuditLevel | undefined {
  const value = process.env.MDOCS_AUDIT_LEVEL;
  return value === 'full' || value === 'metadata' || value === 'off' ? value : undefined;
}
