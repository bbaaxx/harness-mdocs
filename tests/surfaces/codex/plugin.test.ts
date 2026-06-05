import * as fs from 'fs';
import * as path from 'path';

const pluginRoot = path.resolve(__dirname, '../../../src/surfaces/codex/plugin');

describe('Codex plugin packaging', () => {
  test('manifest exists and references existing skills path', () => {
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.name).toBe('mdocs');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.skills).toBe('./skills/');
    expect(fs.existsSync(path.join(pluginRoot, 'skills'))).toBe(true);
    expect(manifest.interface.displayName).toBe('Mdocs');
    expect(manifest.interface.capabilities).toEqual(expect.arrayContaining(['Write', 'Interactive']));
  });

  test('Codex skills use advisory enforcement wording', () => {
    const skillFiles = [
      path.join(pluginRoot, 'skills', 'mdocs-workflow', 'SKILL.md'),
      path.join(pluginRoot, 'skills', 'mdocs-initiative', 'SKILL.md'),
      path.join(pluginRoot, 'skills', 'mdocs-orchestrator', 'SKILL.md')
    ];

    for (const file of skillFiles) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toMatch(/^---\nname:/);
      expect(content).not.toContain('opencode');
      expect(content).not.toContain('Task tool');
      expect(content).not.toContain('plugin blocks');
      expect(content).not.toContain('automatically audited');
      expect(content).not.toMatch(/\{\s*[A-Za-z0-9_]+\s*\}/);
    }
  });
});
