import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../../src/core';
import { createPiAdapter } from '../../../src/surfaces/pi/adapter';
import createPiExtension from '../../../src/surfaces/pi/extension';
import { createMockExtensionAPI } from './mock';

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-pi-adapter-'));
  return dir;
}

describe('pi adapter', () => {
  test('createPiAdapter returns an object with a core', () => {
    const projectDir = tempProject();
    const { core } = createPiAdapter(projectDir);
    expect(core).toBeDefined();
    expect(core.projectDir).toBe(projectDir);
    expect(core.managers.workflow).toBeDefined();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('adapter core agrees with a directly constructed core', () => {
    const projectDir = tempProject();
    const { core } = createPiAdapter(projectDir);
    const direct = createMdocsCore(projectDir, {
      bootstrap: { installInitiativeTitle: 'Install and Configure pi-mdocs' }
    });
    expect(core.mdocsRoot).toBe(direct.mdocsRoot);
    expect(core.contract).toBeDefined();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});

describe('pi extension default export', () => {
  test('is a function (factory)', () => {
    expect(typeof createPiExtension).toBe('function');
  });

  test('registers tools and event handlers without throwing', () => {
    const projectDir = tempProject();
    process.chdir(projectDir);
    const api = createMockExtensionAPI();
    expect(() => createPiExtension(api as any)).not.toThrow();
    expect(api.tools.length).toBe(13);
    expect(api.handlers.some(h => h.event === 'tool_call')).toBe(true);
    expect(api.handlers.some(h => h.event === 'tool_result')).toBe(true);
    expect(api.handlers.some(h => h.event === 'before_agent_start')).toBe(true);
    expect(api.handlers.some(h => h.event === 'session_start')).toBe(true);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('every registered tool has promptSnippet and promptGuidelines', () => {
    const projectDir = tempProject();
    process.chdir(projectDir);
    const api = createMockExtensionAPI();
    createPiExtension(api as any);
    for (const tool of api.tools) {
      expect(typeof tool.promptSnippet).toBe('string');
      expect(tool.promptSnippet.length).toBeGreaterThan(0);
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
      expect(tool.promptGuidelines.length).toBeGreaterThan(0);
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.parameters).toBeDefined();
    }
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});
