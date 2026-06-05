import * as path from 'path';
import * as fs from 'fs';
import { AuditLog } from '../../src/core/audit';

const testDir = path.join(__dirname, 'test-audit');

describe('AuditLog', () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test('appends events to audit.log', () => {
    const audit = new AuditLog(testDir);
    audit.append({
      timestamp: '2025-05-24T10:00:00Z',
      type: 'tool',
      initiativeId: 'test-init',
      step: 'EXECUTE',
      details: { toolName: 'read' }
    });

    const logPath = path.join(testDir, 'audit.log');
    expect(fs.existsSync(logPath)).toBe(true);

    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]);
    expect(event.type).toBe('tool');
    expect(event.initiativeId).toBe('test-init');
    expect(event.details.toolName).toBe('read');
  });

  test('query filters by initiativeId', () => {
    const audit = new AuditLog(testDir);
    audit.append({
      timestamp: '2025-05-24T10:00:00Z',
      type: 'tool',
      initiativeId: 'init-a',
      step: 'EXECUTE',
      details: { toolName: 'read' }
    });
    audit.append({
      timestamp: '2025-05-24T10:01:00Z',
      type: 'tool',
      initiativeId: 'init-b',
      step: 'PLAN',
      details: { toolName: 'write' }
    });
    audit.append({
      timestamp: '2025-05-24T10:02:00Z',
      type: 'workflow',
      initiativeId: 'init-a',
      step: 'VERIFY',
      details: { eventType: 'workflow.advance' }
    });

    const results = audit.query({ initiativeId: 'init-a' });
    expect(results.length).toBe(2);
    expect(results.every(r => r.initiativeId === 'init-a')).toBe(true);
  });

  test('query filters by type', () => {
    const audit = new AuditLog(testDir);
    audit.append({
      timestamp: '2025-05-24T10:00:00Z',
      type: 'tool',
      initiativeId: 'init-a',
      step: 'EXECUTE',
      details: { toolName: 'read' }
    });
    audit.append({
      timestamp: '2025-05-24T10:01:00Z',
      type: 'workflow',
      initiativeId: 'init-a',
      step: 'VERIFY',
      details: { eventType: 'workflow.advance' }
    });

    const results = audit.query({ type: 'workflow' });
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('workflow');
  });

  test('query respects limit', () => {
    const audit = new AuditLog(testDir);
    for (let i = 0; i < 5; i++) {
      audit.append({
        timestamp: `2025-05-24T10:0${i}:00Z`,
        type: 'tool',
        initiativeId: 'init-a',
        step: 'EXECUTE',
        details: { toolName: `tool-${i}` }
      });
    }

    const results = audit.query({ limit: 2 });
    expect(results.length).toBe(2);
    expect(results[0].details.toolName).toBe('tool-3');
    expect(results[1].details.toolName).toBe('tool-4');
  });

  test('summarize returns chronological events for initiative', () => {
    const audit = new AuditLog(testDir);
    audit.append({
      timestamp: '2025-05-24T10:00:00Z',
      type: 'tool',
      initiativeId: 'target',
      step: 'PLAN',
      details: { toolName: 'read' }
    });
    audit.append({
      timestamp: '2025-05-24T10:01:00Z',
      type: 'tool',
      initiativeId: 'other',
      step: 'EXECUTE',
      details: { toolName: 'write' }
    });
    audit.append({
      timestamp: '2025-05-24T10:02:00Z',
      type: 'workflow',
      initiativeId: 'target',
      step: 'VERIFY',
      details: { eventType: 'workflow.advance' }
    });

    const results = audit.summarize('target');
    expect(results.length).toBe(2);
    expect(results[0].timestamp).toBe('2025-05-24T10:00:00Z');
    expect(results[1].timestamp).toBe('2025-05-24T10:02:00Z');
  });

  test('returns empty array when no audit.log exists', () => {
    const audit = new AuditLog(testDir);
    const results = audit.query();
    expect(results).toEqual([]);
  });

  test('rotates log when exceeding 10MB', () => {
    const audit = new AuditLog(testDir);
    const largeDetails = { payload: 'x'.repeat(1024) };

    // Write enough data to exceed 10MB
    for (let i = 0; i < 11000; i++) {
      audit.append({
        timestamp: '2025-05-24T10:00:00Z',
        type: 'tool',
        initiativeId: 'init',
        step: 'EXECUTE',
        details: largeDetails
      });
    }

    const logPath = path.join(testDir, 'audit.log');
    const backupPath = `${logPath}.1`;

    expect(fs.existsSync(backupPath)).toBe(true);

    // Current log should be small (just a few recent entries)
    const currentSize = fs.statSync(logPath).size;
    expect(currentSize).toBeLessThan(MAX_LOG_SIZE);

    // Backup should contain old entries
    const backupLines = fs.readFileSync(backupPath, 'utf8').split('\n').filter(Boolean);
    expect(backupLines.length).toBeGreaterThan(0);
  });

  test('keeps max 3 backups during rotation', () => {
    const audit = new AuditLog(testDir);
    const largeDetails = { payload: 'x'.repeat(1024) };

    // Trigger rotation 4 times
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let i = 0; i < 11000; i++) {
        audit.append({
          timestamp: '2025-05-24T10:00:00Z',
          type: 'tool',
          initiativeId: 'init',
          step: 'EXECUTE',
          details: largeDetails
        });
      }
    }

    // Check that backup .4 does not exist
    expect(fs.existsSync(path.join(testDir, 'audit.log.4'))).toBe(false);

    // Check that backups .1, .2, .3 exist
    expect(fs.existsSync(path.join(testDir, 'audit.log.1'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'audit.log.2'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'audit.log.3'))).toBe(true);
  });
});

// Need to expose MAX_LOG_SIZE for tests
const MAX_LOG_SIZE = 10 * 1024 * 1024;
