"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLog = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUPS = 3;
class AuditLog {
    logPath;
    level;
    maxBytes;
    maxBackups;
    constructor(baseDir, options = {}) {
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
    rotateIfNeeded() {
        if (!fs.existsSync(this.logPath))
            return;
        const stats = fs.statSync(this.logPath);
        if (stats.size < this.maxBytes)
            return;
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
    append(event) {
        if (this.level === 'off')
            return;
        this.rotateIfNeeded();
        const line = JSON.stringify(this.level === 'metadata' ? this.metadataOnly(event) : event) + '\n';
        fs.appendFileSync(this.logPath, line, 'utf8');
    }
    metadataOnly(event) {
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
    query(options = {}) {
        if (!fs.existsSync(this.logPath))
            return [];
        const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
        const events = [];
        for (const line of lines) {
            try {
                const event = JSON.parse(line);
                if (options.type && event.type !== options.type)
                    continue;
                if (options.initiativeId && event.initiativeId !== options.initiativeId)
                    continue;
                if (options.startDate && event.timestamp < options.startDate)
                    continue;
                if (options.endDate && event.timestamp > options.endDate)
                    continue;
                events.push(event);
            }
            catch {
                // Skip malformed lines
            }
        }
        if (options.limit) {
            return events.slice(-options.limit);
        }
        return events;
    }
    summarize(initiativeId) {
        return this.query({ initiativeId });
    }
}
exports.AuditLog = AuditLog;
function positiveInt(value) {
    if (!value)
        return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
function envAuditLevel() {
    const value = process.env.MDOCS_AUDIT_LEVEL;
    return value === 'full' || value === 'metadata' || value === 'off' ? value : undefined;
}
//# sourceMappingURL=audit.js.map