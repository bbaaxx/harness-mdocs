import { MdocsLinter } from '../../src/core/validation/linter';
import * as fs from 'fs';
import * as path from 'path';

const testDir = path.join(__dirname, 'test-linter');

beforeEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
  fs.mkdirSync(path.join(testDir, 'initiatives'), { recursive: true });
  fs.mkdirSync(path.join(testDir, 'wiki', 'architecture'), { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe('MdocsLinter', () => {
  test('perfect initiative scores 5/5', () => {
    const linter = new MdocsLinter(testDir);
    const content = `---
id: perfect
title: Perfect Initiative
status: active
created: 2025-05-24
updated: 2025-05-24
owner: test
tags: [test]
related_wiki: []
expected_duration: suppress
---

## Objective
This is a perfectly clear and detailed objective that explains exactly what needs to be built and why it matters for the project.

## Plan
- [ ] Implement feature in src/types.ts
- [ ] Add tests in src/__tests__/feature.test.ts
- [ ] Update README.md with examples

## Progress Log
- [2025-05-24] Created initiative

## Artifacts
- wiki/decisions/feature-design.md

## Acceptance Criteria
- All tests pass
- Build succeeds
- README updated
`;
    fs.writeFileSync(path.join(testDir, 'initiatives', 'perfect--2025-05-24.md'), content, 'utf8');
    const result = linter.lintFile(path.join(testDir, 'initiatives', 'perfect--2025-05-24.md'));
    
    expect(result.type).toBe('initiative');
    expect(result.score).toBe(5);
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('initiative missing objective scores low', () => {
    const linter = new MdocsLinter(testDir);
    const content = `---
id: bad
title: Bad Initiative
status: active
created: 2025-05-24
updated: 2025-05-24
owner: test
tags: [test]
related_wiki: []
---

## Objective

## Plan
- [ ] Do something

## Progress Log

## Artifacts
`;
    fs.writeFileSync(path.join(testDir, 'initiatives', 'bad--2025-05-24.md'), content, 'utf8');
    const result = linter.lintFile(path.join(testDir, 'initiatives', 'bad--2025-05-24.md'));
    
    expect(result.score).toBeLessThan(4);
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.message.includes('Objective'))).toBe(true);
  });

  test('initiative with vague plan items gets warning', () => {
    const linter = new MdocsLinter(testDir);
    const content = `---
id: vague
title: Vague Initiative
status: active
created: 2025-05-24
updated: 2025-05-24
owner: test
tags: [test]
related_wiki: []
---

## Objective
Build a new feature for the system with proper implementation and testing to ensure quality.

## Plan
- [ ] Research how to implement this
- [ ] Investigate possible approaches
- [ ] Implement feature in src/feature.ts

## Progress Log

## Artifacts

## Acceptance Criteria
- Feature works
`;
    fs.writeFileSync(path.join(testDir, 'initiatives', 'vague--2025-05-24.md'), content, 'utf8');
    const result = linter.lintFile(path.join(testDir, 'initiatives', 'vague--2025-05-24.md'));
    
    expect(result.issues.some(i => i.severity === 'warning' && i.message.includes('Vague plan item'))).toBe(true);
  });

  test('initiative without file paths gets error', () => {
    const linter = new MdocsLinter(testDir);
    const content = `---
id: no-paths
title: No Paths Initiative
status: active
created: 2025-05-24
updated: 2025-05-24
owner: test
tags: [test]
related_wiki: []
---

## Objective
Build something amazing and useful for the project that everyone will love.

## Plan
- [ ] Do step one
- [ ] Do step two
- [ ] Do step three

## Progress Log

## Artifacts

## Acceptance Criteria
- It works
`;
    fs.writeFileSync(path.join(testDir, 'initiatives', 'no-paths--2025-05-24.md'), content, 'utf8');
    const result = linter.lintFile(path.join(testDir, 'initiatives', 'no-paths--2025-05-24.md'));
    
    expect(result.issues.some(i => i.severity === 'error' && i.message.includes('No file paths'))).toBe(true);
    expect(result.passed).toBe(false);
  });

  test('initiative missing frontmatter fields gets errors', () => {
    const linter = new MdocsLinter(testDir);
    const content = `---
id: missing-frontmatter
title: Missing Fields
---

## Objective
Build something.

## Plan
- [ ] Step 1

## Progress Log

## Artifacts
`;
    fs.writeFileSync(path.join(testDir, 'initiatives', 'missing-frontmatter--2025-05-24.md'), content, 'utf8');
    const result = linter.lintFile(path.join(testDir, 'initiatives', 'missing-frontmatter--2025-05-24.md'));
    
    expect(result.issues.filter(i => i.severity === 'error').length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(3);
  });

  test('wiki entry with good content scores well', () => {
    const linter = new MdocsLinter(testDir);
    const content = `---
id: good-wiki
title: Good Wiki Entry
category: architecture
created: 2025-05-24
updated: 2025-05-24
related_initiatives: [test-init]
tags: [architecture, design]
---

## Overview
This is a comprehensive wiki entry that explains the architecture decisions in great detail. It covers multiple aspects of the system design including data flow, component interactions, and error handling strategies.

## Design Principles
We follow these core principles when making architectural decisions for the project.

## Trade-offs
Here are the trade-offs we considered and why we chose this approach over alternatives.
`;
    fs.writeFileSync(path.join(testDir, 'wiki', 'architecture', 'good-wiki.md'), content, 'utf8');
    const result = linter.lintFile(path.join(testDir, 'wiki', 'architecture', 'good-wiki.md'));
    
    expect(result.type).toBe('wiki');
    expect(result.score).toBe(5);
    expect(result.passed).toBe(true);
  });

  test('wiki entry with short content gets warning', () => {
    const linter = new MdocsLinter(testDir);
    const content = `---
id: short-wiki
title: Short Wiki Entry
category: architecture
created: 2025-05-24
updated: 2025-05-24
related_initiatives: []
tags: [test]
---

Short content.
`;
    fs.writeFileSync(path.join(testDir, 'wiki', 'architecture', 'short-wiki.md'), content, 'utf8');
    const result = linter.lintFile(path.join(testDir, 'wiki', 'architecture', 'short-wiki.md'));
    
    expect(result.issues.some(i => i.severity === 'warning' && i.message.includes('short'))).toBe(true);
  });

  test('lintAll scans initiatives and wiki', () => {
    const linter = new MdocsLinter(testDir);
    
    // Create initiative
    const initContent = `---
id: test
title: Test Initiative
status: active
created: 2025-05-24
updated: 2025-05-24
owner: test
tags: [test]
related_wiki: []
---

## Objective
Build a test feature in src/test.ts.

## Plan
- [ ] Implement

## Progress Log

## Artifacts

## Acceptance Criteria
- Works
`;
    fs.writeFileSync(path.join(testDir, 'initiatives', 'test--2025-05-24.md'), initContent, 'utf8');
    
    // Create wiki
    const wikiContent = `---
id: test-wiki
title: Test Wiki
category: architecture
created: 2025-05-24
updated: 2025-05-24
related_initiatives: [test]
tags: [test]
---

This is a wiki entry with enough content to pass the linter quality checks.
`;
    fs.writeFileSync(path.join(testDir, 'wiki', 'architecture', 'test-wiki.md'), wikiContent, 'utf8');
    
    const results = linter.lintAll();
    
    expect(results.length).toBe(2);
    expect(results.some(r => r.type === 'initiative')).toBe(true);
    expect(results.some(r => r.type === 'wiki')).toBe(true);
  });

  test('non-mdocs file returns error', () => {
    const linter = new MdocsLinter(testDir);
    fs.writeFileSync(path.join(testDir, 'random.md'), 'random content', 'utf8');
    const result = linter.lintFile(path.join(testDir, 'random.md'));
    
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.issues[0].message).toContain('not in initiatives');
  });

  test('lintAll reports broken wiki backlinks and missing completion memory', () => {
    const initiativesDir = path.join(testDir, 'initiatives');
    const wikiDir = path.join(testDir, 'wiki', 'architecture');
    fs.mkdirSync(initiativesDir, { recursive: true });
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(initiativesDir, 'done--2026-05-29.md'), `---
id: "done"
title: "Done Initiative"
status: "done"
created: "2026-05-29"
updated: "2026-05-29"
tags: ["memory"]
related_wiki: ["architecture/decision"]
---

## Objective
Capture durable memory after completion.

## Plan
- [x] Finish work

## Progress Log
- Done

## Artifacts
`, 'utf8');
    fs.writeFileSync(path.join(wikiDir, 'decision.md'), `---
id: "decision"
title: "Decision"
category: "architecture"
created: "2026-05-29"
updated: "2026-05-29"
related_initiatives: []
tags: ["memory"]
---

This decision should link back to the initiative.
`, 'utf8');

    const linter = new MdocsLinter(testDir);
    const messages = linter.lintAll().flatMap(r => r.issues.map(i => i.message));

    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('Wiki architecture/decision missing backlink to initiative done'),
      expect.stringContaining('Done initiative done has no stable wiki learning')
    ]));
  });

  test('lintAll graph includes directory-v2 _status.md initiatives and status aliases', () => {
    const initiativesDir = path.join(testDir, 'initiatives');
    const wikiDir = path.join(testDir, 'wiki', 'architecture');

    fs.mkdirSync(path.join(initiativesDir, 'dir-linked'), { recursive: true });
    fs.mkdirSync(path.join(initiativesDir, 'dir-complete'), { recursive: true });

    fs.writeFileSync(path.join(initiativesDir, 'dir-linked', '_status.md'), `---
id: dir-linked
title: Directory Linked
status: active
started: 2026-06-19
tags: [compatibility]
related_wiki: ["architecture/dir-note"]
---

Directory-v2 linked initiative.
`, 'utf8');

    fs.writeFileSync(path.join(initiativesDir, 'dir-complete', '_status.md'), `---
id: dir-complete
title: Directory Complete
status: complete
started: 2026-06-19
completed: 2026-06-19
tags: [compatibility]
related_wiki: []
---

Directory-v2 complete initiative.
`, 'utf8');

    fs.writeFileSync(path.join(wikiDir, 'dir-note.md'), `---
id: dir-note
title: Directory Note
category: architecture
created: 2026-06-19
updated: 2026-06-19
related_initiatives: []
tags: [compatibility]
lifecycle: stable
---

Directory note.
`, 'utf8');

    const linter = new MdocsLinter(testDir);
    const messages = linter.lintAll().flatMap(r => r.issues.map(i => i.message));

    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('Wiki architecture/dir-note missing backlink to initiative dir-linked'),
      expect.stringContaining('Done initiative dir-complete has no stable wiki learning')
    ]));
  });

  test('stable wiki sources satisfy done initiative learning without backlink warning', () => {
    const initiativesDir = path.join(testDir, 'initiatives');
    const wikiDir = path.join(testDir, 'wiki');
    fs.writeFileSync(path.join(initiativesDir, 'done-source--2026-06-19.md'), `---
id: done-source
title: Done Source
status: done
created: 2026-06-19
updated: 2026-06-19
tags: [compatibility]
related_wiki: []
---

## Objective
Complete work with sourced learning.

## Plan
- [x] Finish

## Progress Log
- Done

## Artifacts
`, 'utf8');
    fs.writeFileSync(path.join(wikiDir, 'root-learning.md'), `---
id: root-learning
title: Root Learning
lifecycle: stable
source_initiatives: [done-source]
tags: [compatibility]
---

Root-level learning from done initiative.
`, 'utf8');

    const linter = new MdocsLinter(testDir);
    const messages = linter.lintAll().flatMap(r => r.issues.map(i => i.message));

    expect(messages).not.toEqual(expect.arrayContaining([
      expect.stringContaining('Done initiative done-source has no stable wiki learning'),
      expect.stringContaining('missing backlink to initiative done-source')
    ]));
  });
});
