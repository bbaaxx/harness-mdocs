import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createMdocsCore } from '../../src/core';
import { createClaudeCodeHooks } from '../../src/surfaces/claude-code/hooks';

const THIN_STATUS = `---
id: consumer-init
title: Consumer Init
status: active
started: 2026-06-24
updated: 2026-06-24
owner: consumer
tags: [a, b]
priority: high
---
This is a prose-only consumer body with no sections.
`;

function seed(
  projectDir: string,
  recordMode: 'full' | 'metadata-only'
): { core: ReturnType<typeof createMdocsCore>; statusPath: string } {
  const mdocsRoot = path.join(projectDir, 'mdocs');
  fs.mkdirSync(path.join(mdocsRoot, 'initiatives', 'consumer-init'), { recursive: true });
  const statusPath = path.join(mdocsRoot, 'initiatives', 'consumer-init', '_status.md');
  fs.writeFileSync(statusPath, THIN_STATUS, 'utf8');

  const core = createMdocsCore(projectDir, {
    compatibility: { initiativeMode: 'directory', initiativeRecordMode: recordMode }
  });
  core.managers.workflow.setActiveInitiative('consumer-init');
  // Step must be non-IDLE for the progress-log branch to be reachable.
  core.managers.workflow.resumeAt('EXECUTE');
  return { core, statusPath };
}

test('metadata-only postToolUse skips the progress-log write but still audits', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-hook-meta-'));
  const { core, statusPath } = seed(projectDir, 'metadata-only');
  const before = fs.readFileSync(statusPath, 'utf8');
  const auditPath = path.join(projectDir, 'mdocs', 'audit.log');

  createClaudeCodeHooks(core).postToolUse({ tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } });

  const after = fs.readFileSync(statusPath, 'utf8');
  // Thin consumer _status.md is untouched: no injected sections, byte-stable.
  expect(after).toBe(before);
  expect(after).not.toContain('## Progress Log');
  expect(after).not.toContain('executed at step');
  // The audit log still records the tool use (audit append is not gated).
  expect(fs.readFileSync(auditPath, 'utf8')).toContain('"toolName":"write"');
});

test('full-mode postToolUse still appends a progress entry to _status.md', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-hook-full-'));
  const { core, statusPath } = seed(projectDir, 'full');

  createClaudeCodeHooks(core).postToolUse({ tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } });

  const after = fs.readFileSync(statusPath, 'utf8');
  // Same non-IDLE + active-initiative setup, but full mode mutates the file.
  expect(after).toContain('## Progress Log');
  expect(after).toContain('executed at step EXECUTE');
});
