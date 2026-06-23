import * as path from 'path';
import * as fs from 'fs';
import pluginDefault from '../../../src/surfaces/opencode';
import * as packageRoot from '../../../src';
import * as apiRoot from '../../../src/api';
import opencodePlugin from '../../../src/surfaces/opencode/opencode';
import { createOpencodeAdapter as createPlugin } from '../../../src/surfaces/opencode/adapter';
import { createOpencodeTools } from '../../../src/surfaces/opencode/tools';
import { InitiativeManager } from '../../../src/core/managers/initiative';

const testDir = path.join(__dirname, 'test-plugin');

function copyDir(source: string, target: string) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

describe('Plugin Tools', () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test('mdocs_dispatch returns assembled context for existing initiative', async () => {
    const plugin = createPlugin(testDir);
    // Initialize mdocs structure
    (plugin as any).tool.mdocs_init.execute();

    // Create an initiative
    const fs = require('fs');
    const initiativeDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.mkdirSync(initiativeDir, { recursive: true });
    fs.writeFileSync(
      path.join(initiativeDir, 'test-initiative--2025-05-24.md'),
      `---
id: "test-initiative"
title: "Test Initiative"
status: "active"
created: "2025-05-24"
updated: "2025-05-24"
owner: "test"
tags: ["test"]
related_wiki: ["testing/test-entry"]
---

## Objective
Test the dispatch tool

## Plan
- [ ] Step 1
- [x] Step 2

## Progress Log
- Created

## Artifacts
`
    );

    // Create a wiki entry
    const wikiDir = path.join(testDir, 'mdocs', 'wiki', 'testing');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(
      path.join(wikiDir, 'test-entry.md'),
      `---
id: "test-entry"
title: "Test Entry"
category: "testing"
created: "2025-05-24"
updated: "2025-05-24"
related_initiatives: ["test-initiative"]
tags: ["test"]
---

Wiki content for testing`
    );

    const result = await (plugin as any).tool.mdocs_dispatch.execute({ initiativeId: 'test-initiative' });

    expect(result.error).toBeUndefined();
    expect(result.initiativeId).toBe('test-initiative');
    expect(result.step).toBe('IDLE');
    expect(result.relatedWikiCount).toBe(1);
    expect(result.context).toContain('Test Initiative');
    expect(result.context).toContain('Test the dispatch tool');
    expect(result.context).toContain('Wiki content for testing');
    expect(result.context).toContain('Step 1');
    expect(result.context).toContain('Step 2');
  });

  test('mdocs_dispatch returns error for missing initiative', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();

    const result = await (plugin as any).tool.mdocs_dispatch.execute({ initiativeId: 'non-existent' });

    expect(result.error).toBe('Initiative not found');
  });

  test('mdocs_dispatch includes related wiki entries in context', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();

    const initiativeDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.mkdirSync(initiativeDir, { recursive: true });
    fs.writeFileSync(
      path.join(initiativeDir, 'multi-wiki--2025-05-24.md'),
      `---
id: "multi-wiki"
title: "Multi Wiki"
status: "active"
created: "2025-05-24"
updated: "2025-05-24"
owner: "test"
tags: ["test"]
related_wiki: ["testing/entry-a", "testing/entry-b"]
---

## Objective
Multiple wiki entries

## Plan
- [ ] Step 1

## Progress Log

## Artifacts
`
    );

    const wikiDir = path.join(testDir, 'mdocs', 'wiki', 'testing');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(
      path.join(wikiDir, 'entry-a.md'),
      `---
id: "entry-a"
title: "Entry A"
category: "testing"
created: "2025-05-24"
updated: "2025-05-24"
related_initiatives: ["multi-wiki"]
tags: []
---

Content A`
    );
    fs.writeFileSync(
      path.join(wikiDir, 'entry-b.md'),
      `---
id: "entry-b"
title: "Entry B"
category: "testing"
created: "2025-05-24"
updated: "2025-05-24"
related_initiatives: ["multi-wiki"]
tags: []
---

Content B`
    );

    const result = await (plugin as any).tool.mdocs_dispatch.execute({ initiativeId: 'multi-wiki' });

    expect(result.error).toBeUndefined();
    expect(result.relatedWikiCount).toBe(2);
    expect(result.context).toContain('Content A');
    expect(result.context).toContain('Content B');
  });

  test('mdocs_dispatch uses active initiative when no initiativeId provided', async () => {
    // Initialize mdocs structure first
    const pluginInit = createPlugin(testDir);
    (pluginInit as any).tool.mdocs_init.execute();

    const initiativeDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.mkdirSync(initiativeDir, { recursive: true });
    fs.writeFileSync(
      path.join(initiativeDir, 'active-init--2025-05-24.md'),
      `---
id: "active-init"
title: "Active Initiative"
status: "active"
created: "2025-05-24"
updated: "2025-05-24"
owner: "test"
tags: ["test"]
related_wiki: []
---

## Objective
The active one

## Plan
- [ ] Step 1

## Progress Log

## Artifacts
`
    );

    // Set active initiative by writing workflow state directly BEFORE creating the plugin
    const workflowStatePath = path.join(testDir, 'mdocs', '.workflow-state.json');
    fs.writeFileSync(workflowStatePath, JSON.stringify({
      currentStep: 'PLAN',
      activeInitiative: 'active-init',
      stepHistory: [{ step: 'PLAN', timestamp: new Date().toISOString() }]
    }, null, 2), 'utf8');

    // Create a new plugin instance that will read the updated state
    const plugin = createPlugin(testDir);

    const result = await (plugin as any).tool.mdocs_dispatch.execute({});

    expect(result.error).toBeUndefined();
    expect(result.initiativeId).toBe('active-init');
    expect(result.context).toContain('The active one');
  });

  test('tool.execute.after logs progress to active initiative with dated filename', async () => {
    const pluginInit = createPlugin(testDir);
    (pluginInit as any).tool.mdocs_init.execute();

    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'active-init',
      title: 'Active Initiative',
      status: 'active',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: [],
      relatedWiki: [],
      objective: 'Track hook progress',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    fs.writeFileSync(path.join(testDir, 'mdocs', '.workflow-state.json'), JSON.stringify({
      currentStep: 'EXECUTE',
      activeInitiative: 'active-init',
      stepHistory: [{ step: 'EXECUTE', timestamp: new Date().toISOString() }]
    }, null, 2), 'utf8');

    const plugin = createPlugin(testDir) as any;
    await plugin['tool.execute.after']({ name: 'bash', args: { command: 'npm test' } }, {});

    const initiative = manager.read('active-init--2025-05-24.md');
    expect(initiative?.progressLog.some(note => note.includes('bash executed at step EXECUTE'))).toBe(true);
  });

  test('event hook logs progress to active initiative with dated filename', () => {
    const pluginInit = createPlugin(testDir);
    (pluginInit as any).tool.mdocs_init.execute();

    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'active-init',
      title: 'Active Initiative',
      status: 'active',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: [],
      relatedWiki: [],
      objective: 'Track event progress',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    fs.writeFileSync(path.join(testDir, 'mdocs', '.workflow-state.json'), JSON.stringify({
      currentStep: 'VERIFY',
      activeInitiative: 'active-init',
      stepHistory: [{ step: 'VERIFY', timestamp: new Date().toISOString() }]
    }, null, 2), 'utf8');

    const plugin = createPlugin(testDir) as any;
    plugin.event({ type: 'workflow.advance' });

    const initiative = manager.read('active-init--2025-05-24.md');
    expect(initiative?.progressLog.some(note => note.includes('Event: workflow.advance'))).toBe(true);
  });

  test('event hook ignores opencode event envelopes without top-level type', () => {
    const plugin = createPlugin(testDir) as any;

    expect(() => plugin.event({ event: { type: 'session.created' } })).not.toThrow();
    expect(() => plugin.event({})).not.toThrow();
  });

  test('permission and before hooks gate Write/Edit but not Bash (F2: bash ungated by content)', async () => {
    // F2 (workflow-enforcement-dogfood-friction-log): the destructive-bash
    // gate was deleted. opencode's `tool.execute.before` and `permission.ask`
    // hooks delegate to the SAME `canExecuteTool` engine as the Claude Code
    // surface — there is no separate opencode unsafe-tool list. So at
    // UNDERSTAND, Bash (`rm -rf build`) is now ALLOWED (audited, not blocked),
    // while Write/Edit to a non-mdocs source file would still be blocked.
    const pluginInit = createPlugin(testDir);
    (pluginInit as any).tool.mdocs_init.execute();
    fs.writeFileSync(path.join(testDir, 'mdocs', '.workflow-state.json'), JSON.stringify({
      currentStep: 'UNDERSTAND',
      activeInitiative: null,
      stepHistory: []
    }, null, 2), 'utf8');

    const plugin = createPlugin(testDir) as any;

    // Bash is no longer blocked by content at any step — before-hook resolves
    // (does not throw), permission.ask allows.
    await expect(plugin['tool.execute.before']({
      tool: 'bash',
      parameters: { command: 'rm -rf build' }
    })).resolves.toBeUndefined();
    await expect(plugin['permission.ask']({
      tool: 'bash',
      parameters: { command: 'rm -rf build' }
    })).resolves.toEqual({ action: 'allow' });

    // Write/Edit enforcement is unchanged: a non-mdocs write is still gated
    // at UNDERSTAND (the real "plan before mutation" guardrail).
    await expect(plugin['tool.execute.before']({
      tool: 'write',
      parameters: { filePath: 'src/app.ts', content: 'x' }
    })).rejects.toThrow('Workflow gate: write blocked at step UNDERSTAND');
    await expect(plugin['permission.ask']({
      tool: 'write',
      parameters: { filePath: 'src/app.ts', content: 'x' }
    })).resolves.toEqual({ action: 'ask' });

    // Read tools remain always-allowed.
    await expect(plugin['permission.ask']({
      name: 'read',
      args: { filePath: 'README.md' }
    })).resolves.toEqual({ action: 'allow' });
  });

  test('event hook handles nested initiative and eventType wiki events', async () => {
    const pluginInit = createPlugin(testDir);
    (pluginInit as any).tool.mdocs_init.execute();
    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'event-init',
      title: 'Event Initiative',
      status: 'active',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: [],
      relatedWiki: [],
      objective: 'Track event branches',
      plan: [],
      progressLog: [],
      artifacts: []
    });
    fs.writeFileSync(path.join(testDir, 'mdocs', '.workflow-state.json'), JSON.stringify({
      currentStep: 'VERIFY',
      activeInitiative: 'event-init',
      stepHistory: []
    }, null, 2), 'utf8');

    const plugin = createPlugin(testDir) as any;
    plugin.event({ event: { type: 'initiative.create' } });
    plugin.event({ eventType: 'wiki.create' });

    const initiative = manager.read('event-init--2025-05-24.md');
    expect(initiative?.progressLog).toEqual(expect.arrayContaining([
      expect.stringContaining('Event: initiative.create'),
      expect.stringContaining('Event: wiki.create')
    ]));
    await expect(plugin.tool.mdocs_audit.execute({ initiativeId: 'event-init', limit: 2 })).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'initiative', details: { eventType: 'initiative.create' } }),
        expect.objectContaining({ type: 'wiki', details: { eventType: 'wiki.create' } })
      ])
    });
  });

  test('mdocs_dispatch returns error when no initiativeId and no active initiative', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();

    const result = await (plugin as any).tool.mdocs_dispatch.execute({});

    expect(result.error).toBe('No initiativeId provided and no active initiative');
  });

  test('config-created initiative uses the id stem for its filename and index entry', () => {
    const plugin = createPlugin(testDir);
    const today = new Date().toISOString().split('T')[0];

    plugin.config({});

    const expectedFileName = `install-mdocs--${today}.md`;
    const initiativePath = path.join(testDir, 'mdocs', 'initiatives', expectedFileName);
    const indexPath = path.join(testDir, 'mdocs', 'initiatives', 'INDEX.md');
    expect(fs.existsSync(initiativePath)).toBe(true);
    expect(fs.readFileSync(indexPath, 'utf8')).toContain(expectedFileName);
  });

  test('mdocs_lookup resolves initiative id and title to the actual filename', async () => {
    const plugin = createPlugin(testDir);
    const today = new Date().toISOString().split('T')[0];
    plugin.config({});

    const byId = await (plugin as any).tool.mdocs_lookup.execute({ query: 'install-mdocs', field: 'id' });
    const byTitle = await (plugin as any).tool.mdocs_lookup.execute({ query: 'Install and Configure opencode-mdocs', field: 'title' });

    expect(byId.error).toBeUndefined();
    expect(byTitle.error).toBeUndefined();
    expect(byId.filename).toBe(`install-mdocs--${today}.md`);
    expect(byTitle.filename).toBe(`install-mdocs--${today}.md`);
  });

  test('mdocs_lookup supports slug, partial title, and metadata results', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const initiativeDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.writeFileSync(
      path.join(initiativeDir, 'install-and-configure-opencode-mdocs--2026-05-27.md'),
      `---
id: "install-mdocs"
title: "Install and Configure opencode-mdocs"
status: "done"
created: "2026-05-27"
updated: "2026-05-27"
owner: "system"
tags: ["setup", "plugin"]
related_wiki: []
---

## Objective
Legacy filename

## Plan

## Progress Log

## Artifacts
`,
      'utf8'
    );

    const bySlug = await (plugin as any).tool.mdocs_lookup.execute({ query: 'install-and-configure-opencode-mdocs', field: 'slug' });
    const byPartialTitle = await (plugin as any).tool.mdocs_lookup.execute({ query: 'Configure opencode', field: 'title' });

    expect(bySlug).toEqual({
      type: 'initiative',
      filename: 'install-and-configure-opencode-mdocs--2026-05-27.md',
      id: 'install-mdocs',
      title: 'Install and Configure opencode-mdocs',
      status: 'done',
      tags: ['setup', 'plugin']
    });
    expect(byPartialTitle.filename).toBe('install-and-configure-opencode-mdocs--2026-05-27.md');
  });

  test('mdocs_lookup default lookup resolves omitted-field slug queries', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const initiativeDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.writeFileSync(
      path.join(initiativeDir, 'install-and-configure-opencode-mdocs--2026-05-27.md'),
      `---
id: "install-mdocs"
title: "Install and Configure opencode-mdocs"
status: "done"
created: "2026-05-27"
updated: "2026-05-27"
owner: "system"
tags: ["setup", "plugin"]
related_wiki: []
---

## Objective
Legacy filename

## Plan

## Progress Log

## Artifacts
`,
      'utf8'
    );

    const result = await (plugin as any).tool.mdocs_lookup.execute({ query: 'install-and-configure-opencode-mdocs' });

    expect(result.filename).toBe('install-and-configure-opencode-mdocs--2026-05-27.md');
  });

  test('mdocs_lookup returns query with no-match error', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();

    const result = await (plugin as any).tool.mdocs_lookup.execute({ query: 'missing-initiative' });

    expect(result).toEqual({ error: 'No initiatives found for query', query: 'missing-initiative' });
  });

  test('initiative index displays actual filename from disk for mismatched legacy files', () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const initiativeDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.writeFileSync(
      path.join(initiativeDir, 'install-and-configure-opencode-mdocs--2026-05-27.md'),
      `---
id: "install-mdocs"
title: "Install and Configure opencode-mdocs"
status: "done"
created: "2026-05-27"
updated: "2026-05-27"
owner: "system"
tags: ["setup", "plugin"]
related_wiki: []
---

## Objective
Legacy filename

## Plan

## Progress Log

## Artifacts
`,
      'utf8'
    );

    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'new-id',
      title: 'New Initiative',
      status: 'active',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'test',
      tags: [],
      relatedWiki: [],
      objective: 'Trigger index update',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    const index = fs.readFileSync(path.join(initiativeDir, 'INDEX.md'), 'utf8');
    expect(index).toContain('install-and-configure-opencode-mdocs--2026-05-27.md');
    expect(index).not.toContain('install-mdocs--2026-05-27.md');
  });

  test('mdocs initiative.create creates an active initiative with pending plan items', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const today = new Date().toISOString().split('T')[0];

    const result = await (plugin as any).tool.mdocs.execute({
      command: 'initiative.create',
      args: {
        title: 'Command Created Initiative',
        id: 'cmd-created',
        owner: 'agent',
        tags: ['cli'],
        relatedWiki: ['developer/commands'],
        objective: 'Create initiatives from a command',
        plan: ['Write tests', { description: 'Implement command', status: 'done' }]
      }
    });

    expect(result).toEqual({ success: true, filename: `cmd-created--${today}.md`, id: 'cmd-created' });

    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    const initiative = manager.read(result.filename);
    expect(initiative).toMatchObject({
      id: 'cmd-created',
      title: 'Command Created Initiative',
      status: 'active',
      owner: 'agent',
      tags: ['cli'],
      relatedWiki: ['developer/commands'],
      objective: 'Create initiatives from a command'
    });
    expect(initiative?.created).toBe(today);
    expect(initiative?.updated).toBe(today);
    expect(initiative?.plan).toEqual([
      { description: 'Write tests', status: 'pending' },
      { description: 'Implement command', status: 'pending' }
    ]);
    expect(initiative?.progressLog[0]).toContain('Created initiative via mdocs command');
  });

  test('mdocs initiative.update resolves existing filename and appends progress note', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    const legacyPath = path.join(testDir, 'mdocs', 'initiatives', 'legacy-title--2026-05-27.md');
    fs.writeFileSync(
      legacyPath,
      `---
id: "stable-id"
title: "Stable Title"
status: "active"
created: "2026-05-27"
updated: "2026-05-27"
owner: "old-owner"
tags: ["old"]
related_wiki: []
---

## Objective
Existing file

## Plan

## Progress Log
- Existing note

## Artifacts
`,
      'utf8'
    );

    const result = await (plugin as any).tool.mdocs.execute({
      command: 'initiative.update',
      args: {
        id: 'stable-id',
        updates: {
          status: 'paused',
          tags: ['new'],
          priority: 'high',
          dueDate: '2026-06-01',
          dependsOn: ['dependency'],
          owner: 'new-owner'
        },
        progressNote: 'Paused while dependency finishes'
      }
    });

    expect(result).toEqual({ success: true, filename: 'stable-id--2026-05-27.md', id: 'stable-id' });
    expect(fs.existsSync(legacyPath)).toBe(false);

    const updated = manager.read('stable-id--2026-05-27.md');
    expect(updated).toMatchObject({
      id: 'stable-id',
      status: 'paused',
      tags: ['new'],
      priority: 'high',
      dueDate: '2026-06-01',
      dependsOn: ['dependency'],
      owner: 'new-owner'
    });
    expect(updated?.progressLog).toContain('Existing note');
    expect(updated?.progressLog).toContain('Paused while dependency finishes');
  });

  test('mdocs initiative.done resolves existing filename and marks initiative done', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'finish-me',
      title: 'Finish Me',
      status: 'active',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'agent',
      tags: [],
      relatedWiki: [],
      objective: 'Complete this',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    const result = await (plugin as any).tool.mdocs.execute({ command: 'initiative.done', args: { id: 'finish-me' } });

    expect(result).toEqual({ success: true, filename: 'finish-me--2026-05-29.md', id: 'finish-me' });
    const initiative = manager.read('finish-me--2026-05-29.md');
    expect(initiative?.status).toBe('done');
    expect(initiative?.progressLog.some(note => note.includes('Marked done via mdocs command'))).toBe(true);
  });

  test('mdocs wiki.create creates a wiki entry and indices', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const today = new Date().toISOString().split('T')[0];

    const result = await (plugin as any).tool.mdocs.execute({
      command: 'wiki.create',
      args: {
        category: 'developer',
        id: 'command-tool',
        title: 'Command Tool',
        content: 'Use the mdocs command tool.',
        relatedInitiatives: ['cmd-created'],
        tags: ['cli']
      }
    });

    expect(result).toEqual({ success: true, filename: 'developer/command-tool.md', id: 'command-tool' });
    const entry = fs.readFileSync(path.join(testDir, 'mdocs', 'wiki', 'developer', 'command-tool.md'), 'utf8');
    expect(entry).toContain('title: "Command Tool"');
    expect(entry).toContain(`created: "${today}"`);
    expect(entry).toContain('Use the mdocs command tool.');
    expect(fs.readFileSync(path.join(testDir, 'mdocs', 'wiki', 'developer', 'INDEX.md'), 'utf8')).toContain('Command Tool');
  });

  test('mdocs_validate includes graph lint results', async () => {
    const plugin = createPlugin(testDir);
    await (plugin as any).tool.mdocs_init.execute();

    const result = await (plugin as any).tool.mdocs_validate.execute();

    expect(result.graph).toBeDefined();
    expect(result.graph.results).toEqual(expect.any(Array));
  });

  test('mdocs_validate respects configured standalone wiki categories', async () => {
    const plugin = createPlugin(testDir, { standaloneCategories: ['repo'] });
    (plugin as any).tool.mdocs_init.execute();

    const wikiDir = path.join(testDir, 'mdocs', 'wiki', 'repo');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'example.md'), `---
id: "example"
title: "Example"
category: "repo"
created: "2026-06-03"
updated: "2026-06-03"
tags: []
---

Repository knowledge.
`, 'utf8');

    const result = await (plugin as any).tool.mdocs_validate.execute();

    expect(result.wiki.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('repo/example.md is not referenced by any initiative')
    ]));
  });

  test('mdocs_validate tool and mdocs validate command return combined validation results', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const initiativeDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.writeFileSync(path.join(initiativeDir, 'broken--2026-05-29.md'), `---
id: "broken"
title: "Broken"
status: "active"
created: "2026-05-29"
related_wiki: ["developer/missing"]
---

## Objective

## Plan

## Progress Log

## Artifacts
`, 'utf8');
    const wikiDir = path.join(testDir, 'mdocs', 'wiki', 'developer');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'bad.md'), '---\nid: ""\ntitle: ""\ncategory: ""\n---\n', 'utf8');

    const toolResult = await (plugin as any).tool.mdocs_validate.execute();
    const commandResult = await (plugin as any).tool.mdocs.execute({ command: 'validate', args: {} });

    expect(toolResult.valid).toBe(false);
    expect(toolResult.initiatives.warnings).toEqual(expect.arrayContaining([expect.stringContaining('broken--2026-05-29.md references missing wiki entry: developer/missing')]));
    expect(toolResult.wiki.errors).toEqual(expect.arrayContaining([expect.stringContaining('developer/bad.md missing id')]));
    expect(commandResult).toEqual(toolResult);
  });

  test('mdocs_status includes validation summary', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const initiativeDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.writeFileSync(path.join(initiativeDir, 'missing-title.md'), `---
id: "missing-title"
title: ""
status: "active"
created: "2026-05-29"
related_wiki: []
---
`, 'utf8');

    const result = await (plugin as any).tool.mdocs_status.execute();

    expect(result.validation.valid).toBe(false);
    expect(result.validation.initiatives.errors).toEqual(expect.arrayContaining([expect.stringContaining('missing-title.md missing title')]));
  });

  test('mdocs_status returns validation when an initiative file is malformed', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const initiativeDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.writeFileSync(path.join(initiativeDir, 'malformed.md'), 'not frontmatter', 'utf8');

    const result = await (plugin as any).tool.mdocs_status.execute();

    expect(result.error).toBeUndefined();
    expect(result.validation.valid).toBe(false);
    expect(result.validation.initiatives.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('malformed.md invalid initiative format')
    ]));
  });

  test('mdocs_status includes resume cockpit for active stale initiative', async () => {
    const pluginInit = createPlugin(testDir);
    await (pluginInit as any).tool.mdocs_init.execute();
    const initDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.writeFileSync(path.join(initDir, 'status-resume--2020-01-01.md'), `---
id: "status-resume"
title: "Status Resume"
status: "active"
created: "2020-01-01"
updated: "2020-01-01"
owner: "agent"
tags: []
related_wiki: []
blockers: ["blocked by dep"]
---

## Objective
Resume status branch.

## Plan
- [/] Current work
- [ ] Later work

## Progress Log
- Old progress

## Artifacts
`, 'utf8');
    fs.writeFileSync(path.join(testDir, 'mdocs', '.workflow-state.json'), JSON.stringify({
      currentStep: 'PLAN',
      activeInitiative: 'status-resume',
      stepHistory: []
    }, null, 2), 'utf8');

    const plugin = createPlugin(testDir) as any;
    const result = await plugin.tool.mdocs_status.execute();

    expect(result.resume).toMatchObject({
      initiative: { id: 'status-resume', title: 'Status Resume', status: 'active' },
      currentStep: 'PLAN',
      nextAction: 'Current work',
      currentPlanItem: { description: 'Current work', status: 'in-progress' },
      blockers: ['blocked by dep'],
      latestProgress: 'Old progress',
      lastUpdated: '2020-01-01',
      staleWarning: true
    });
  });

  test('mdocs returns helpful errors for invalid and unsupported commands', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();

    await expect((plugin as any).tool.mdocs.execute({ command: 'initiative.create', args: {} })).resolves.toEqual({ error: 'initiative.create requires title' });
    await expect((plugin as any).tool.mdocs.execute({ command: 'initiative.update', args: {} })).resolves.toEqual({ error: 'initiative.update requires id' });
    await expect((plugin as any).tool.mdocs.execute({ command: 'initiative.done', args: { id: 'missing' } })).resolves.toEqual({ error: 'Initiative not found: missing' });
    await expect((plugin as any).tool.mdocs.execute({ command: 'wiki.create', args: { category: 'developer', id: 'missing-title' } })).resolves.toEqual({ error: 'wiki.create requires id and title' });
    await expect((plugin as any).tool.mdocs.execute({ command: 'initiative.delete', args: {} }))
      .resolves.toEqual({ error: 'initiative.delete requires id' });
    await expect((plugin as any).tool.mdocs.execute({ command: 'initiative.delete', args: { id: 'missing' } }))
      .resolves.toEqual({ error: 'Initiative not found: missing' });
    await expect((plugin as any).tool.mdocs.execute({ command: 'initiative.archive', args: {} }))
      .resolves.toEqual({ error: 'initiative.archive requires id' });
    await expect((plugin as any).tool.mdocs.execute({ command: 'wiki.delete', args: { category: 'developer' } }))
      .resolves.toEqual({ error: 'wiki.delete requires id' });

    const unknown = await (plugin as any).tool.mdocs.execute({ command: 'nope', args: {} });
    expect(unknown.error).toContain('Unsupported mdocs command: nope');
    expect(unknown.supportedCommands).toEqual(expect.arrayContaining([
      'initiative.create',
      'initiative.update',
      'initiative.done',
      'initiative.delete',
      'initiative.archive',
      'wiki.create',
      'wiki.update',
      'wiki.stub',
      'wiki.delete',
      'wiki.list',
      'wiki.link',
      'wiki.xref',
      'validate',
      'index.sync'
    ]));
  });

  test('mdocs initiative.delete removes initiative file and updates index', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'delete-me',
      title: 'Delete Me',
      status: 'active',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'agent',
      tags: ['cleanup'],
      relatedWiki: [],
      objective: 'Remove obsolete work.',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    const result = await (plugin as any).tool.mdocs.execute({ command: 'initiative.delete', args: { id: 'delete-me' } });

    expect(result).toEqual({ success: true, id: 'delete-me', deletedFilename: 'delete-me--2026-05-29.md' });
    expect(fs.existsSync(path.join(testDir, 'mdocs', 'initiatives', 'delete-me--2026-05-29.md'))).toBe(false);
    const index = fs.readFileSync(path.join(testDir, 'mdocs', 'initiatives', 'INDEX.md'), 'utf8');
    expect(index).not.toContain('Delete Me');
  });

  test('mdocs wiki.delete removes entry and updates indices', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();

    await (plugin as any).tool.mdocs.execute({
      command: 'wiki.create',
      args: { category: 'developer', id: 'obsolete', title: 'Obsolete', content: 'Remove me.', tags: ['cleanup'] }
    });

    const result = await (plugin as any).tool.mdocs.execute({ command: 'wiki.delete', args: { category: 'developer', id: 'obsolete' } });

    expect(result).toEqual({ success: true, category: 'developer', id: 'obsolete', deletedFilename: 'developer/obsolete.md' });
    expect(fs.existsSync(path.join(testDir, 'mdocs', 'wiki', 'developer', 'obsolete.md'))).toBe(false);
    expect(fs.readFileSync(path.join(testDir, 'mdocs', 'wiki', 'developer', 'INDEX.md'), 'utf8')).not.toContain('Obsolete');
  });

  test('mdocs wiki.list returns all entries or filters by category', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    await (plugin as any).tool.mdocs.execute({ command: 'wiki.create', args: { category: 'developer', id: 'commands', title: 'Commands', content: 'Command docs.', tags: ['cli'] } });
    await (plugin as any).tool.mdocs.execute({ command: 'wiki.create', args: { category: 'architecture', id: 'storage', title: 'Storage', content: 'Storage docs.', tags: ['architecture'] } });

    const all = await (plugin as any).tool.mdocs.execute({ command: 'wiki.list', args: {} });
    const developer = await (plugin as any).tool.mdocs.execute({ command: 'wiki.list', args: { category: 'developer' } });

    expect(all.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'developer', id: 'commands', title: 'Commands', tags: ['cli'] }),
      expect.objectContaining({ category: 'architecture', id: 'storage', title: 'Storage', tags: ['architecture'] })
    ]));
    expect(developer.entries).toEqual([
      expect.objectContaining({ category: 'developer', id: 'commands', title: 'Commands', tags: ['cli'] })
    ]);
  });

  test('mdocs index.sync regenerates initiative and wiki indices', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'sync-me',
      title: 'Sync Me',
      status: 'active',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'agent',
      tags: ['index'],
      relatedWiki: [],
      objective: 'Regenerate indices.',
      plan: [],
      progressLog: [],
      artifacts: []
    });
    await (plugin as any).tool.mdocs.execute({ command: 'wiki.create', args: { category: 'developer', id: 'index-doc', title: 'Index Doc', content: 'Index docs.' } });

    fs.writeFileSync(path.join(testDir, 'mdocs', 'initiatives', 'INDEX.md'), '# Initiatives\n\nStale', 'utf8');
    fs.writeFileSync(path.join(testDir, 'mdocs', 'wiki', 'INDEX.md'), '# Wiki\n\nStale', 'utf8');
    fs.writeFileSync(path.join(testDir, 'mdocs', 'wiki', 'developer', 'INDEX.md'), '# developer\n\nStale', 'utf8');

    const result = await (plugin as any).tool.mdocs.execute({ command: 'index.sync', args: {} });

    expect(result).toEqual({
      success: true,
      regenerated: expect.arrayContaining(['initiatives/INDEX.md', 'wiki/INDEX.md', 'wiki/developer/INDEX.md'])
    });
    expect(fs.readFileSync(path.join(testDir, 'mdocs', 'initiatives', 'INDEX.md'), 'utf8')).toContain('Sync Me');
    expect(fs.readFileSync(path.join(testDir, 'mdocs', 'wiki', 'INDEX.md'), 'utf8')).toContain('[developer](developer/INDEX.md)');
    expect(fs.readFileSync(path.join(testDir, 'mdocs', 'wiki', 'developer', 'INDEX.md'), 'utf8')).toContain('Index Doc');
  });

  test('mdocs initiative.archive moves done initiative to archive and updates indices', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'archive-me',
      title: 'Archive Me',
      status: 'done',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'agent',
      tags: ['archive'],
      relatedWiki: [],
      objective: 'Archive completed work.',
      plan: [],
      progressLog: ['Completed'],
      artifacts: []
    });

    const result = await (plugin as any).tool.mdocs.execute({ command: 'initiative.archive', args: { id: 'archive-me' } });

    expect(result).toEqual({ success: true, id: 'archive-me', archivedFilename: 'archive-me--2026-05-29.md' });
    expect(fs.existsSync(path.join(testDir, 'mdocs', 'initiatives', 'archive-me--2026-05-29.md'))).toBe(false);
    expect(fs.existsSync(path.join(testDir, 'mdocs', 'initiatives', 'archive', 'archive-me--2026-05-29.md'))).toBe(true);
    expect(fs.readFileSync(path.join(testDir, 'mdocs', 'initiatives', 'INDEX.md'), 'utf8')).not.toContain('Archive Me');
    expect(fs.readFileSync(path.join(testDir, 'mdocs', 'initiatives', 'archive', 'INDEX.md'), 'utf8')).toContain('Archive Me');
  });

  test('mdocs initiative.archive rejects missing and active initiatives', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'not-done',
      title: 'Not Done',
      status: 'active',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'agent',
      tags: [],
      relatedWiki: [],
      objective: 'Still active.',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    await expect((plugin as any).tool.mdocs.execute({ command: 'initiative.archive', args: { id: 'missing' } }))
      .resolves.toEqual({ error: 'Initiative not found: missing' });
    await expect((plugin as any).tool.mdocs.execute({ command: 'initiative.archive', args: { id: 'not-done' } }))
      .resolves.toEqual({ error: 'Only done initiatives can be archived: not-done' });
  });

  test('mdocs_resume returns next action, blockers, latest progress, and validation', async () => {
    const plugin = createPlugin(testDir);
    await (plugin as any).tool.mdocs_init.execute();
    const initDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.writeFileSync(path.join(initDir, 'resume--2026-05-29.md'), `---
id: "resume"
title: "Resume Cockpit"
status: "active"
created: "2026-05-29"
updated: "2026-05-29"
owner: "agent"
tags: ["resume"]
related_wiki: []
next_action: "Continue with dispatch retrieval."
blockers: ["Need metadata"]
---

## Objective
Help fresh agents resume.

## Plan
- [ ] Add cockpit

## Progress Log
- Baseline captured
- Metadata added

## Artifacts
`, 'utf8');

    const result = await (plugin as any).tool.mdocs_resume.execute({ initiativeId: 'resume' });

    expect(result.initiative.id).toBe('resume');
    expect(result.nextAction).toBe('Continue with dispatch retrieval.');
    expect(result.blockers).toEqual(['Need metadata']);
    expect(result.latestProgress).toBe('Metadata added');
    expect(result.validation).toBeDefined();
  });

  test('mdocs_search normalizes sparse results and tool catches return errors', async () => {
    const boom = () => { throw new Error('boom'); };
    const searchQuery = jest.fn().mockReturnValue([{ type: 'wiki' }, { id: 'x', title: 'X', score: 2 }]);
    const sparseTools = createOpencodeTools({
      managers: {
        mdocs: {},
        workflow: {},
        initiatives: {},
        search: { query: searchQuery },
        audit: {}
      },
      commands: {}
    } as any);
    const throwingTools = createOpencodeTools({
      managers: {
        mdocs: { init: boom },
        workflow: { status: boom },
        initiatives: { list: boom, findByQuery: boom, findById: boom },
        search: { query: boom },
        audit: { query: boom }
      },
      commands: { validationResult: boom }
    } as any);

    await expect(sparseTools.mdocs_search.execute({} as any)).resolves.toEqual({
      results: [
        { type: 'wiki', id: '', title: '', score: 0 },
        { type: '', id: 'x', title: 'X', score: 2 }
      ]
    });
    expect(searchQuery).toHaveBeenCalledWith('', {});
    await expect(throwingTools.mdocs_init.execute()).resolves.toEqual({ error: 'boom' });
    await expect(throwingTools.mdocs_status.execute()).resolves.toMatchObject({ error: 'boom', initiatives: [] });
    await expect(throwingTools.mdocs_validate.execute()).resolves.toEqual({ error: 'boom' });
    await expect(throwingTools.mdocs_search.execute({ query: 'x' })).resolves.toEqual({ error: 'boom', results: [] });
    await expect(throwingTools.mdocs_lookup.execute({ query: 'x' })).resolves.toEqual({ error: 'boom' });
    await expect(throwingTools.mdocs_resume.execute({ initiativeId: 'x' })).resolves.toEqual({ error: 'boom' });
  });
});

describe('Config Hook', () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  test('auto-registers agent and skills on empty config', () => {
    const plugin = createPlugin(testDir);
    const cfg: any = {};
    plugin.config(cfg);

    expect(cfg.agent).toBeDefined();
    expect(cfg.agent['mdocs-orchestrator']).toEqual({
      description: 'Orchestrates work using the mdocs initiative/wiki workflow.',
      mode: 'primary',
      permission: {
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
        list: 'allow',
        edit: 'allow',
        write: 'allow',
        bash: 'allow'
      },
      prompt: expect.stringContaining('You are a workflow orchestrator using the mdocs system.')
    });
    expect(cfg.agent['mdocs-orchestrator'].prompt).not.toContain('---');
    expect(cfg.agent['mdocs-orchestrator'].prompt).not.toContain('description:');
    expect(cfg.agents).toBeUndefined();

    expect(cfg.skills).toBeDefined();
    expect(cfg.skills.paths).toBeDefined();
    expect(cfg.skills.paths.length).toBeGreaterThan(0);
  });

  test('does not duplicate agent if already registered', () => {
    const plugin = createPlugin(testDir);
    const cfg: any = {
      agent: {
        'mdocs-orchestrator': {
          description: 'Existing orchestrator',
          mode: 'primary',
          permission: {},
          prompt: 'Existing prompt'
        }
      }
    };
    plugin.config(cfg);

    expect(Object.keys(cfg.agent)).toEqual(['mdocs-orchestrator']);
    expect(cfg.agent['mdocs-orchestrator'].prompt).toBe('Existing prompt');
    expect(cfg.agents).toBeUndefined();
  });

  test('does not duplicate skills path if already present', () => {
    const plugin = createPlugin(testDir);
    const cfg: any = {
      skills: { paths: ['/path/to/opencode-mdocs/skills'] }
    };
    plugin.config(cfg);

    expect(cfg.skills.paths.length).toBe(1);
  });

  test('appends skills path to existing skills config', () => {
    const plugin = createPlugin(testDir);
    const cfg: any = {
      skills: { paths: ['/other/skills'] }
    };
    plugin.config(cfg);

    expect(cfg.skills.paths.length).toBe(2);
    expect(cfg.skills.paths.some((p: string) => p.includes('harness-mdocs'))).toBe(true);
  });

  test('gracefully handles config mutation errors', () => {
    const plugin = createPlugin(testDir);
    const cfg: any = Object.create(null);
    cfg.skills = Object.create(null);
    // This should not throw
    expect(() => plugin.config(cfg)).not.toThrow();
  });

  test('exposes singular tool hook and no legacy tools hook', () => {
    const plugin = createPlugin(testDir) as any;

    expect(Object.keys(plugin.tool).sort()).toEqual([
      'mdocs',
      'mdocs_audit',
      'mdocs_dispatch',
      'mdocs_index_check',
      'mdocs_init',
      'mdocs_lookup',
      'mdocs_resume',
      'mdocs_search',
      'mdocs_status',
      'mdocs_validate'
    ]);
    expect(plugin.tools).toBeUndefined();
  });

  test('all custom tools expose explicit arg schemas for opencode runtime', () => {
    const plugin = createPlugin(testDir) as any;

    for (const [name, definition] of Object.entries(plugin.tool) as Array<[string, any]>) {
      expect(definition.description).toBeTruthy();
      expect(definition.args).toBeDefined();
      expect(typeof definition.execute).toBe('function');
      if (['mdocs_init', 'mdocs_status', 'mdocs_validate'].includes(name)) {
        expect(definition.args).toEqual({});
      }
    }
    expect(plugin.tool.mdocs.args.command).toBeDefined();
    expect(plugin.tool.mdocs_dispatch.args.initiativeId).toBeDefined();
    expect(plugin.tool.mdocs_resume.args.initiativeId).toBeDefined();
  });

  test('mdocs_dispatch includes search-ranked memory and recent audit events', async () => {
    const plugin = createPlugin(testDir);
    await (plugin as any).tool.mdocs_init.execute();
    const initDir = path.join(testDir, 'mdocs', 'initiatives');
    fs.writeFileSync(path.join(initDir, 'dispatch--2026-05-29.md'), `---
id: "dispatch"
title: "Dispatch Memory"
status: "active"
created: "2026-05-29"
updated: "2026-05-29"
owner: "agent"
tags: ["memory"]
related_wiki: []
---

## Objective
Improve durable memory retrieval.

## Plan
- [ ] Add retrieval

## Progress Log
- Baseline captured

## Artifacts
- src/subagent.ts
`, 'utf8');
    const wikiDir = path.join(testDir, 'mdocs', 'wiki', 'architecture');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'durable-memory.md'), `---
id: "durable-memory"
title: "Durable Memory"
category: "architecture"
created: "2026-05-29"
updated: "2026-05-29"
related_initiatives: ["dispatch"]
tags: ["memory"]
---

Durable memory retrieval should include snippets for fresh agents.
`, 'utf8');
    // Set the active initiative and step so audit events are tagged with the initiative id
    fs.writeFileSync(path.join(testDir, 'mdocs', '.workflow-state.json'), JSON.stringify({
      currentStep: 'PLAN',
      activeInitiative: 'dispatch',
      stepHistory: [{ step: 'PLAN', timestamp: new Date().toISOString() }]
    }, null, 2), 'utf8');

    // Re-create plugin to pick up updated workflow state
    const pluginWithState = createPlugin(testDir);
    await (pluginWithState as any)['tool.execute.after']({ name: 'read', args: { filePath: 'src/subagent.ts' } }, {});

    const result = await (pluginWithState as any).tool.mdocs_dispatch.execute({ initiativeId: 'dispatch' });

    expect(result.context).toContain('## Retrieved Memory');
    expect(result.context).toContain('Durable Memory');
    expect(result.context).toContain('## Recent Activity');
  });

  test('default export returns plugin with current opencode tool hook', async () => {
    expect(typeof pluginDefault).toBe('function');

    const hooks = await pluginDefault({ client: {}, project: {}, directory: testDir });

    expect((hooks as any).tool.mdocs_status).toBeDefined();
  });

  test('package root only exposes default plugin for opencode loading', () => {
    expect(Object.keys(packageRoot)).toEqual(['default']);
  });

  test('public API exports live on api subpath', () => {
    expect((apiRoot as any).createMdocsCore).toBeDefined();
    expect((apiRoot as any).WikiManager).toBeDefined();
  });

  test('opencode runtime entrypoint exposes custom tools', async () => {
    expect(typeof opencodePlugin).toBe('function');

    const hooks = await opencodePlugin({ client: {}, project: {}, directory: testDir });

    expect((hooks as any).tool.mdocs_status).toBeDefined();
    expect((hooks as any).tool.mdocs_dispatch).toBeDefined();
    const result = await (hooks as any).tool.mdocs_status.execute({});
    expect(typeof result.output).toBe('string');
  });

  test('mdocs_index_check returns consistent for clean repo', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'check-me',
      title: 'Check Me',
      status: 'active',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'agent',
      tags: ['check'],
      relatedWiki: [],
      objective: 'Check index consistency.',
      plan: [],
      progressLog: [],
      artifacts: []
    });
    await (plugin as any).tool.mdocs.execute({ command: 'wiki.create', args: { category: 'developer', id: 'check-doc', title: 'Check Doc', content: 'Docs.' } });

    const result = await (plugin as any).tool.mdocs_index_check.execute({ mode: 'check' });

    expect(result.consistent).toBe(true);
    expect(result.initiatives.consistent).toBe(true);
    expect(result.wiki.consistent).toBe(true);
    expect(result.repaired).toBe(false);
  });

  test('mdocs_index_check detects and repairs inconsistencies', async () => {
    const plugin = createPlugin(testDir);
    (plugin as any).tool.mdocs_init.execute();
    const manager = new InitiativeManager(path.join(testDir, 'mdocs'));
    manager.create({
      id: 'repair-me',
      title: 'Repair Me',
      status: 'active',
      created: '2026-05-29',
      updated: '2026-05-29',
      owner: 'agent',
      tags: ['repair'],
      relatedWiki: [],
      objective: 'Repair index consistency.',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    // Corrupt the INDEX
    fs.writeFileSync(path.join(testDir, 'mdocs', 'initiatives', 'INDEX.md'), '# Initiatives\n\n- **Ghost** (active) — ghost--2026-05-29.md — 2026-05-29 — []', 'utf8');

    const checkResult = await (plugin as any).tool.mdocs_index_check.execute({ mode: 'check' });
    expect(checkResult.consistent).toBe(false);
    expect(checkResult.initiatives.missing.length).toBeGreaterThan(0);

    const repairResult = await (plugin as any).tool.mdocs_index_check.execute({ mode: 'repair' });
    expect(repairResult.consistent).toBe(true);
    expect(repairResult.repaired).toBe(true);
    expect(fs.readFileSync(path.join(testDir, 'mdocs', 'initiatives', 'INDEX.md'), 'utf8')).toContain('Repair Me');
  });

  test('opencode tools see directory-v2 initiatives', async () => {
    const fixtureRoot = path.resolve(__dirname, '../../fixtures/directory-v2-mdocs');
    copyDir(fixtureRoot, testDir);
    const plugin = createPlugin(testDir);

    const lookup = await (plugin as any).tool.mdocs_lookup.execute({ query: 'example-active' });
    expect(lookup).toMatchObject({ id: 'example-active', filename: 'example-active' });

    const status = await (plugin as any).tool.mdocs_status.execute({});
    expect(status.initiatives.some((initiative: any) => initiative.id === 'example-active')).toBe(true);

    const resumeList = await (plugin as any).tool.mdocs_resume.execute({});
    expect(resumeList.resumable.some((initiative: any) => initiative.id === 'example-active')).toBe(true);

    const resume = await (plugin as any).tool.mdocs_resume.execute({ initiativeId: 'example-active' });
    expect(resume.initiative).toMatchObject({ id: 'example-active', status: 'active' });

    const dispatch = await (plugin as any).tool.mdocs_dispatch.execute({ initiativeId: 'example-active' });
    expect(dispatch.error).toBeUndefined();
    expect(dispatch.initiativeId).toBe('example-active');
  });

  test('default export wraps custom tool results in opencode ToolResult shape', async () => {
    const hooks = await pluginDefault({ client: {}, project: {}, directory: testDir }) as any;
    await hooks.tool.mdocs_init.execute({});

    const result = await hooks.tool.mdocs_status.execute({});

    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('"workflow"');
    expect(result.metadata.workflow).toBeDefined();
  });
});
