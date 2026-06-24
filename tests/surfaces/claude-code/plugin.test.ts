import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'src/surfaces/claude-code/plugin');
const ASSETS_DIR = path.join(REPO_ROOT, 'src/surfaces/claude-code/assets');

function readJson(relPath: string) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
}

describe('Claude Code plugin', () => {
  let pluginJson: any;
  let marketplaceJson: any;
  let packageJson: any;

  beforeAll(() => {
    pluginJson = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_DIR, '.claude-plugin/plugin.json'), 'utf8')
    );
    marketplaceJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, '.claude-plugin/marketplace.json'), 'utf8')
    );
    packageJson = readJson('package.json');
  });

  describe('plugin.json', () => {
    test('has required fields per verified schema', () => {
      expect(pluginJson.name).toBe('mdocs');
      expect(pluginJson.version).toBeDefined();
      expect(pluginJson.author).toBeDefined();
      expect(pluginJson.author.name).toBe('bbaaxx');
      expect(pluginJson.license).toBe('MIT');
    });

    test('version matches package.json', () => {
      expect(pluginJson.version).toBe(packageJson.version);
    });

    test('declares skills path', () => {
      expect(pluginJson.skills).toBe('./skills/');
    });

    test('declares agents path', () => {
      expect(pluginJson.agents).toEqual(['./agents/mdocs-orchestrator.md']);
    });
  });

  describe('marketplace.json', () => {
    test('has required fields', () => {
      expect(marketplaceJson.name).toBeDefined();
      expect(marketplaceJson.owner).toBeDefined();
      expect(marketplaceJson.owner.name).toBe('bbaaxx');
      expect(marketplaceJson.plugins).toBeDefined();
      expect(marketplaceJson.plugins.length).toBeGreaterThan(0);
    });

    test('plugin source path exists on disk', () => {
      const entry = marketplaceJson.plugins[0];
      const sourcePath = entry.source;
      expect(sourcePath).toMatch(/^\.\//);
      const resolved = path.join(REPO_ROOT, sourcePath);
      expect(fs.existsSync(resolved)).toBe(true);
      expect(fs.existsSync(path.join(resolved, '.claude-plugin/plugin.json'))).toBe(true);
    });

    test('plugin entry version matches plugin.json version', () => {
      const entry = marketplaceJson.plugins[0];
      expect(entry.version).toBe(pluginJson.version);
    });
  });

  describe('hooks', () => {
    test('PreToolUse hook has correct matcher', () => {
      const pre = pluginJson.hooks.PreToolUse;
      expect(pre).toBeDefined();
      expect(pre.length).toBeGreaterThan(0);
      expect(pre[0].matcher).toBe('Write|Edit|Bash');
    });

    test('PostToolUse matcher contains Task and Agent', () => {
      const post = pluginJson.hooks.PostToolUse;
      expect(post).toBeDefined();
      expect(post.length).toBeGreaterThan(0);
      const matcher = post[0].matcher as string;
      expect(matcher).toContain('Task');
      expect(matcher).toContain('Agent');
    });

    test('hook commands reference dist/cli/hooks and use CLAUDE_PLUGIN_ROOT', () => {
      const allHooks = [
        ...pluginJson.hooks.PreToolUse,
        ...pluginJson.hooks.PostToolUse
      ];
      for (const group of allHooks) {
        for (const hook of group.hooks) {
          expect(hook.command).toContain('${CLAUDE_PLUGIN_ROOT}');
          expect(hook.command).toContain('dist/cli/hooks/');
          expect(hook.command).toMatch(/pre-tool-use\.js|post-tool-use\.js/);
          expect(hook.command).not.toContain('npx');
        }
      }
    });

    test('no npx in any hook command', () => {
      const allHookCommands: string[] = [];
      for (const event of Object.values(pluginJson.hooks) as any[][]) {
        for (const group of event) {
          for (const hook of group.hooks) {
            allHookCommands.push(hook.command);
          }
        }
      }
      for (const cmd of allHookCommands) {
        expect(cmd).not.toContain('npx');
      }
    });
  });

  describe('MCP server', () => {
    test('declares mdocs MCP server running bundled standalone entrypoint', () => {
      const mcp = pluginJson.mcpServers.mdocs;
      expect(mcp).toBeDefined();
      expect(mcp.command).toBe('node');
      expect(mcp.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/cli/mcp-server.js']);
    });

    test('sets MDOCS_PROJECT_DIR via CLAUDE_PROJECT_DIR', () => {
      const mcp = pluginJson.mcpServers.mdocs;
      expect(mcp.env.MDOCS_PROJECT_DIR).toBe('${CLAUDE_PROJECT_DIR}');
    });
  });

  describe('skill/agent parity', () => {
    const skillNames = ['mdocs-workflow', 'mdocs-initiative', 'mdocs-orchestrator'];

    test.each(skillNames)('plugin skill %s equals assets skill', (skillName) => {
      const pluginSkill = fs.readFileSync(
        path.join(PLUGIN_DIR, 'skills', skillName, 'SKILL.md'),
        'utf8'
      );
      const assetsSkill = fs.readFileSync(
        path.join(ASSETS_DIR, 'skills', skillName, 'SKILL.md'),
        'utf8'
      );
      expect(pluginSkill).toBe(assetsSkill);
    });

    test('plugin agent equals assets agent', () => {
      const pluginAgent = fs.readFileSync(
        path.join(PLUGIN_DIR, 'agents', 'mdocs-orchestrator.md'),
        'utf8'
      );
      const assetsAgent = fs.readFileSync(
        path.join(ASSETS_DIR, 'agents', 'mdocs-orchestrator.md'),
        'utf8'
      );
      expect(pluginAgent).toBe(assetsAgent);
    });
  });

  describe('bundled dist', () => {
    test('dist/cli/hooks contains pre-tool-use.js and post-tool-use.js', () => {
      const hooksDir = path.join(PLUGIN_DIR, 'dist/cli/hooks');
      expect(fs.existsSync(path.join(hooksDir, 'pre-tool-use.js'))).toBe(true);
      expect(fs.existsSync(path.join(hooksDir, 'post-tool-use.js'))).toBe(true);
    });

    test('dist/cli/index.js exists (CLI entrypoint)', () => {
      expect(fs.existsSync(path.join(PLUGIN_DIR, 'dist/cli/index.js'))).toBe(true);
    });

    test('dist/cli/mcp-server.js is bundled without external MCP runtime requires', () => {
      const bundledMcp = path.join(PLUGIN_DIR, 'dist/cli/mcp-server.js');
      expect(fs.existsSync(bundledMcp)).toBe(true);

      const contents = fs.readFileSync(bundledMcp, 'utf8');
      expect(contents).not.toContain('require("@modelcontextprotocol/sdk');
      expect(contents).not.toContain("require('@modelcontextprotocol/sdk");
      expect(contents).not.toContain('require("zod")');
      expect(contents).not.toContain("require('zod')");
    });
  });
});
