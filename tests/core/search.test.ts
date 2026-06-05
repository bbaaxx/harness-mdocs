import { SearchEngine } from '../../src/core/search';
import { InitiativeManager } from '../../src/core/managers/initiative';
import { WikiManager } from '../../src/core/managers/wiki';
import * as fs from 'fs';
import * as path from 'path';

const testDir = path.join(__dirname, 'test-search');

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

describe('SearchEngine', () => {
  test('indexes initiative content', () => {
    const initiatives = new InitiativeManager(testDir);
    initiatives.create({
      id: 'audit-init',
      title: 'Audit Log Initiative',
      status: 'active',
      priority: 'medium',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: ['audit', 'observability'],
      relatedWiki: [],
      objective: 'Add audit logging to track all changes',
      plan: [{ description: 'Design audit schema', status: 'pending' }],
      progressLog: ['Started research'],
      artifacts: []
    });

    const search = new SearchEngine(testDir);
    search.buildIndex();

    const results = search.query('audit');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('audit-init');
    expect(results[0].type).toBe('initiative');
  });

  test('searching returns relevant results', () => {
    const initiatives = new InitiativeManager(testDir);
    initiatives.create({
      id: 'search-init',
      title: 'Full-Text Search',
      status: 'active',
      priority: 'high',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: ['search', 'discovery'],
      relatedWiki: [],
      objective: 'Implement full-text search across all content',
      plan: [{ description: 'Build inverted index', status: 'in-progress' }],
      progressLog: [],
      artifacts: []
    });

    const search = new SearchEngine(testDir);
    const results = search.query('full-text');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('search-init');
  });

  test('tag filtering narrows results', () => {
    const initiatives = new InitiativeManager(testDir);
    initiatives.create({
      id: 'bug-fix',
      title: 'Fix Critical Bug',
      status: 'active',
      priority: 'critical',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: ['bug', 'critical'],
      relatedWiki: [],
      objective: 'Fix the critical bug in production',
      plan: [],
      progressLog: [],
      artifacts: []
    });
    initiatives.create({
      id: 'feature',
      title: 'New Feature',
      status: 'active',
      priority: 'medium',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: ['feature'],
      relatedWiki: [],
      objective: 'Fix and add new feature',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    const search = new SearchEngine(testDir);
    const allResults = search.query('fix');
    expect(allResults.length).toBe(2);

    const bugResults = search.query('fix', { tags: ['bug'] });
    expect(bugResults.length).toBe(1);
    expect(bugResults[0].id).toBe('bug-fix');
  });

  test('ranking orders by relevance', () => {
    const initiatives = new InitiativeManager(testDir);
    initiatives.create({
      id: 'high-relevance',
      title: 'Search Search Search',
      status: 'active',
      priority: 'medium',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: [],
      relatedWiki: [],
      objective: 'Search search search search',
      plan: [{ description: 'Search implementation', status: 'pending' }],
      progressLog: ['Search started'],
      artifacts: []
    });
    initiatives.create({
      id: 'low-relevance',
      title: 'Other Topic',
      status: 'active',
      priority: 'medium',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: [],
      relatedWiki: [],
      objective: 'Something else entirely',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    const search = new SearchEngine(testDir);
    const results = search.query('search');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('high-relevance');
    expect(results[0].score).toBeGreaterThan(0);
  });

  test('indexes wiki content', () => {
    const wiki = new WikiManager(testDir);
    wiki.create({
      id: 'plugin-design',
      title: 'Plugin Design Document',
      category: 'architecture',
      created: '2025-05-24',
      updated: '2025-05-24',
      relatedInitiatives: [],
      tags: ['plugin', 'architecture'],
      content: 'The plugin architecture uses a modular design pattern.'
    });

    const search = new SearchEngine(testDir);
    const results = search.query('architecture');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.id === 'architecture/plugin-design')).toBe(true);
    expect(results[0].type).toBe('wiki');
  });

  test('returns empty array for no matches', () => {
    const search = new SearchEngine(testDir);
    const results = search.query('nonexistent-term-xyz');
    expect(results).toEqual([]);
  });

  test('filters by status', () => {
    const initiatives = new InitiativeManager(testDir);
    initiatives.create({
      id: 'active-init',
      title: 'Active Initiative',
      status: 'active',
      priority: 'medium',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: [],
      relatedWiki: [],
      objective: 'Test status filtering',
      plan: [],
      progressLog: [],
      artifacts: []
    });
    initiatives.create({
      id: 'done-init',
      title: 'Done Initiative',
      status: 'done',
      priority: 'medium',
      created: '2025-05-24',
      updated: '2025-05-24',
      owner: 'test',
      tags: [],
      relatedWiki: [],
      objective: 'Test status filtering',
      plan: [],
      progressLog: [],
      artifacts: []
    });

    const search = new SearchEngine(testDir);
    const activeResults = search.query('filtering', { status: 'active' });
    expect(activeResults.length).toBe(1);
    expect(activeResults[0].id).toBe('active-init');
  });

  test('query includes snippets and matched field for memory retrieval', () => {
    const wiki = new WikiManager(testDir);
    wiki.create({
      id: 'durable-memory',
      title: 'Durable Memory',
      category: 'architecture',
      created: '2026-05-29',
      updated: '2026-05-29',
      relatedInitiatives: [],
      tags: ['memory'],
      content: 'Durable memory retrieval should include snippets for fresh agents.'
    });
    const search = new SearchEngine(testDir);
    const results = search.query('durable memory');

    expect(results[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      title: expect.any(String),
      score: expect.any(Number),
      snippet: expect.any(String),
      matchedFields: expect.arrayContaining([expect.any(String)])
    }));
  });
});
