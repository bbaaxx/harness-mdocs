import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'src/surfaces/kimi-code/plugin');
const ASSETS_DIR = path.join(REPO_ROOT, 'src/surfaces/kimi-code/assets');

describe('Kimi Code plugin', () => {
  let manifest: any;
  let packageJson: any;

  beforeAll(() => {
    manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'kimi.plugin.json'), 'utf8'));
    packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  });

  describe('kimi.plugin.json', () => {
    test('has required fields per the Kimi plugin manifest schema', () => {
      expect(manifest.name).toBe('mdocs');
      expect(manifest.name).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
      expect(manifest.version).toBeDefined();
      expect(manifest.description).toBeDefined();
      expect(manifest.license).toBe('MIT');
    });

    test('version matches package.json (stamp-versions)', () => {
      expect(manifest.version).toBe(packageJson.version);
    });

    test('declares skills and agents paths', () => {
      expect(manifest.skills).toBe('./skills/');
      expect(manifest.agents).toBe('./agents/');
    });

    test('declares the mdocs MCP server on the bundled entrypoint', () => {
      const mcp = manifest.mcpServers.mdocs;
      expect(mcp).toBeDefined();
      expect(mcp.command).toBe('node');
      expect(mcp.args).toEqual(['./dist/mcp-server.js']);
    });

    test('loads the workflow skill at session start', () => {
      expect(manifest.sessionStart).toEqual({ skill: 'mdocs-workflow' });
    });
  });

  describe('hooks', () => {
    test('declares PreToolUse/PostToolUse/SessionStart hooks with bundled commands', () => {
      const events = manifest.hooks.map((h: any) => h.event);
      expect(events).toContain('PreToolUse');
      expect(events).toContain('PostToolUse');
      expect(events).toContain('SessionStart');

      for (const hook of manifest.hooks) {
        expect(hook.matcher).toBeDefined();
        expect(hook.command).toMatch(/^node \.\/dist\/hooks\/(pre-tool-use|post-tool-use|session-start)\.js$/);
        expect(hook.command).not.toContain('npx');
        expect(hook.timeout).toBeGreaterThan(0);
      }
    });

    test('PreToolUse matcher covers the gated tools', () => {
      const pre = manifest.hooks.find((h: any) => h.event === 'PreToolUse');
      expect(pre.matcher).toContain('Write');
      expect(pre.matcher).toContain('Edit');
      expect(pre.matcher).toContain('Bash');
    });
  });

  describe('skill/agent parity with assets', () => {
    const skillNames = ['mdocs-workflow', 'mdocs-initiative', 'mdocs-orchestrator'];

    test.each(skillNames)('plugin skill %s equals assets skill', (skillName) => {
      const pluginSkill = fs.readFileSync(path.join(PLUGIN_DIR, 'skills', skillName, 'SKILL.md'), 'utf8');
      const assetsSkill = fs.readFileSync(path.join(ASSETS_DIR, 'skills', skillName, 'SKILL.md'), 'utf8');
      expect(pluginSkill).toBe(assetsSkill);
    });

    test('plugin skill has Kimi-required name/description frontmatter', () => {
      for (const skillName of skillNames) {
        const skill = fs.readFileSync(path.join(PLUGIN_DIR, 'skills', skillName, 'SKILL.md'), 'utf8');
        expect(skill).toMatch(/^---\nname: mdocs-/);
        expect(skill).toContain('description:');
      }
    });

    test('plugin agent equals assets agent and has kimi agent frontmatter', () => {
      const pluginAgent = fs.readFileSync(path.join(PLUGIN_DIR, 'agents', 'mdocs-orchestrator.md'), 'utf8');
      const assetsAgent = fs.readFileSync(path.join(ASSETS_DIR, 'agents', 'mdocs-orchestrator.md'), 'utf8');
      expect(pluginAgent).toBe(assetsAgent);
      expect(pluginAgent).toContain('name: mdocs-orchestrator');
      expect(pluginAgent).toContain('description:');
      expect(pluginAgent).toContain('mcp__mdocs__*');
    });
  });

  describe('bundled dist', () => {
    test('dist/mcp-server.js is bundled without external requires', () => {
      const bundled = path.join(PLUGIN_DIR, 'dist/mcp-server.js');
      expect(fs.existsSync(bundled)).toBe(true);
      const contents = fs.readFileSync(bundled, 'utf8');
      expect(contents).not.toContain('require("@modelcontextprotocol/sdk');
      expect(contents).not.toContain("require('@modelcontextprotocol/sdk");
      expect(contents).not.toContain('require("zod")');
      expect(contents).not.toContain("require('zod')");
    });

    test.each(['pre-tool-use', 'post-tool-use', 'session-start'])(
      'dist/hooks/%s.js exists and is self-contained',
      (hook) => {
        const bundled = path.join(PLUGIN_DIR, 'dist/hooks', `${hook}.js`);
        expect(fs.existsSync(bundled)).toBe(true);
        const contents = fs.readFileSync(bundled, 'utf8');
        expect(contents).not.toMatch(/require\(["']\.\./);
      }
    );
  });

  describe('install templates', () => {
    test('kimi-mcp.json template is valid JSON with a relative server path', () => {
      const template = JSON.parse(
        fs.readFileSync(path.join(ASSETS_DIR, 'templates', 'kimi-mcp.json'), 'utf8')
      );
      expect(template.mcpServers.mdocs.command).toBe('node');
      expect(template.mcpServers.mdocs.args[0]).toMatch(/^\.\/node_modules\/harness-mdocs\//);
    });

    test('agents-md snippet template references the MCP tools', () => {
      const snippet = fs.readFileSync(
        path.join(ASSETS_DIR, 'templates', 'kimi-agents-md-snippet.md'),
        'utf8'
      );
      expect(snippet).toContain('mcp__mdocs__mdocs_status');
      expect(snippet).toContain('PreToolUse');
    });
  });
});
