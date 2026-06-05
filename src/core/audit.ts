import * as fs from 'fs';
import * as path from 'path';
import { AuditEvent, StepName } from './types';

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUPS = 3;

export class AuditLog {
  private logPath: string;

  constructor(baseDir: string) {
    this.logPath = path.join(baseDir, 'audit.log');
    // Ensure directory exists
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.logPath)) return;
    const stats = fs.statSync(this.logPath);
    if (stats.size < MAX_LOG_SIZE) return;

    // Remove oldest backup if at max
    const oldestBackup = `${this.logPath}.${MAX_BACKUPS}`;
    if (fs.existsSync(oldestBackup)) {
      fs.unlinkSync(oldestBackup);
    }

    // Shift existing backups up
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
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
    this.rotateIfNeeded();
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(this.logPath, line, 'utf8');
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
