import { SubagentAssembler } from '../../src/core/subagent';
import { Initiative, WikiEntry, SearchResult, AuditEvent } from '../../src/core/types';

describe('SubagentAssembler', () => {
  test('assemble context from initiative and wiki', () => {
    const assembler = new SubagentAssembler();
    const initiative: Initiative = {
      id: 'test', title: 'Test', status: 'active',
      created: '2025-05-24', updated: '2025-05-24', owner: 'a',
      tags: [], relatedWiki: [], objective: 'Build auth',
      plan: [{ description: 'Step 1', status: 'pending' }, { description: 'Step 2', status: 'pending' }], progressLog: [], artifacts: []
    };
    const wiki: WikiEntry[] = [{
      id: 'decision', title: 'Decision', category: 'decisions',
      created: '2025-05-24', updated: '2025-05-24',
      relatedInitiatives: ['test'], tags: [], content: 'Use JWT'
    }];

    const context = assembler.assemble(initiative, wiki, 'EXECUTE');
    expect(context).toContain('Build auth');
    expect(context).toContain('Use JWT');
    expect(context).toContain('EXECUTE');
    expect(context).toContain('Step 1');
    expect(context).toContain('Step 2');
  });

  test('handles empty wiki entries', () => {
    const assembler = new SubagentAssembler();
    const initiative: Initiative = {
      id: 'test', title: 'Test', status: 'active',
      created: '2025-05-24', updated: '2025-05-24', owner: 'a',
      tags: [], relatedWiki: [], objective: 'Build auth',
      plan: [{ description: 'Step 1', status: 'pending' }], progressLog: [], artifacts: []
    };

    const context = assembler.assemble(initiative, [], 'PLAN');
    expect(context).toContain('Build auth');
    expect(context).toContain('PLAN');
  });

  test('assemble includes progress, artifacts, handoff, blockers, and retrieved memory', () => {
    const assembler = new SubagentAssembler();
    const initiative: Initiative = {
      id: 'dispatch', title: 'Dispatch', status: 'active', priority: 'high',
      created: '2026-05-29', updated: '2026-05-29', owner: 'agent',
      tags: ['memory'], relatedWiki: [], objective: 'Improve dispatch memory.',
      plan: [{ description: 'Add retrieval', status: 'pending' }],
      progressLog: ['Baseline captured'], artifacts: ['src/subagent.ts'],
      handoffSummary: 'Dispatch needs richer continuity.',
      blockers: ['Search lacks snippets'],
      nextAction: 'Add search-ranked context.'
    };
    const wiki: WikiEntry[] = [];
    const context = assembler.assemble(initiative, wiki, 'EXECUTE', {
      retrievedMemory: [{ type: 'wiki', id: 'architecture/memory', title: 'Memory', score: 4, snippet: 'Durable memory context', matchedFields: ['content'] }],
      recentEvents: [{ timestamp: '2026-05-29T00:00:00.000Z', type: 'tool', step: 'PLAN', details: { toolName: 'read' } }]
    });

    expect(context).toContain('## Handoff Summary');
    expect(context).toContain('Dispatch needs richer continuity.');
    expect(context).toContain('## Blockers');
    expect(context).toContain('Search lacks snippets');
    expect(context).toContain('## Retrieved Memory');
    expect(context).toContain('Durable memory context');
    expect(context).toContain('## Recent Activity');
    expect(context).toContain('read');
  });
});
