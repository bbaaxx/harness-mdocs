import fs = require('fs');
import * as os from 'os';
import * as path from 'path';
import { atomicWrite, markdownSections, readMarkdownList, readMarkdownSection, writeMarkdownSection } from '../../src/core/markdown';

describe('preserving Markdown primitives', () => {
  test('ignores fenced headings, including mismatched/short closing markers', () => {
    const body = '# Title\n\n## First\nreal\n````md\n## Not real\n```\n## Still code\n~~~~\n````\n## Second\nlast';
    expect(markdownSections(body).map(section => section.name)).toEqual(['First', 'Second']);
    expect(readMarkdownSection(body, 'missing')).toBe('');
    expect(readMarkdownSection(body, 'Second')).toBe('last');
    expect(readMarkdownSection('~~~md\n## Ignored\n~~~\n## Real\nbody\n', 'Real')).toBe('body');
  });

  test('list parser keeps nested/lazy continuation and ignores preamble', () => {
    expect(readMarkdownList('## Notes\nPreamble\n\n- First\nlazy\n  - nested\n\n- Second\n', 'Notes')).toEqual(['First\nlazy\n  - nested', 'Second']);
    expect(readMarkdownList('', 'Notes')).toEqual([]);
  });

  test.each(['', 'Preamble', 'Preamble\n'])('creates missing section in %j', content => {
    const result = writeMarkdownSection(content, 'Plan', '- [ ] Work');
    expect(readMarkdownSection(result, 'Plan')).toBe('- [ ] Work');
    expect(result.startsWith(content)).toBe(true);
  });

  test('handles heading at EOF and section with no trailing newline', () => {
    expect(writeMarkdownSection('## Plan', 'Plan', '- [ ] Work')).toBe('## Plan\n- [ ] Work\n');
    expect(writeMarkdownSection('## Plan\nOld', 'Plan', 'New')).toBe('## Plan\nNew\n');
  });

  test.each(['\n', '\r\n'])('progress append preserves hard breaks and later sections (%j)', newline => {
    const original = '## Progress Log\n\n- Old note  \n\n## Custom\nKeep me  \n'.replace(/\n/g, newline);
    const result = writeMarkdownSection(original, 'Progress Log', '- New note\n  detail', true);
    expect(result).toBe('## Progress Log\n\n- Old note  \n- New note\n  detail\n\n## Custom\nKeep me  \n'.replace(/\n/g, newline));
  });

  test('atomic replacement preserves private mode and leaves no temporary files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-atomic-'));
    const file = path.join(dir, 'record.md');
    try {
      fs.writeFileSync(file, 'old', { mode: 0o600 });
      atomicWrite(file, 'new');
      expect(fs.readFileSync(file, 'utf8')).toBe('new');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir)).toEqual(['record.md']);
      expect(() => atomicWrite(path.join(dir, 'missing.md'), 'value')).toThrow();
      expect(fs.readdirSync(dir)).toEqual(['record.md']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
