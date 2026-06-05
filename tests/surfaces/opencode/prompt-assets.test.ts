import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');

test('opencode packaged prompt assets exist', () => {
  expect(fs.existsSync(path.join(root, 'skills', 'mdocs-workflow', 'SKILL.md'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'skills', 'mdocs-initiative', 'SKILL.md'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'agents', 'mdocs-orchestrator.md'))).toBe(true);
});

test('prompt assets do not contain unresolved template placeholders', () => {
  const files = [
    path.join(root, 'skills', 'mdocs-workflow', 'SKILL.md'),
    path.join(root, 'skills', 'mdocs-initiative', 'SKILL.md'),
    path.join(root, 'agents', 'mdocs-orchestrator.md')
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toMatch(/\{\{[^}]+\}\}/);
    expect(content).not.toMatch(/\[[A-Z_]+:/);
  }
});
