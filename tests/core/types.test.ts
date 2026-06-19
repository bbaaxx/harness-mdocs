import { parseFrontmatter, parseYamlValue } from '../../src/core/types';

describe('frontmatter value parsing', () => {
  test('parses JSON, YAML arrays, quoted strings, and plain scalars', () => {
    expect(parseYamlValue('')).toBe('');
    expect(parseYamlValue('["a","b"]')).toEqual(['a', 'b']);
    expect(parseYamlValue('true')).toBe(true);
    expect(parseYamlValue('42')).toBe(42);
    expect(parseYamlValue('null')).toBeNull();
    expect(parseYamlValue('[a, b, "c", \'d\']')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseYamlValue('[]')).toEqual([]);
    expect(parseYamlValue('"quoted"')).toBe('quoted');
    expect(parseYamlValue("'quoted'")).toBe('quoted');
    expect(parseYamlValue('plain')).toBe('plain');
  });

  test('parses frontmatter boundaries and colon values defensively', () => {
    expect(parseFrontmatter('no frontmatter')).toEqual({});
    expect(parseFrontmatter('---\r\ntitle: A: B\r\nignored\r\n: empty\r\ntags: [a, b]\r\n---\r\nBody')).toEqual({
      title: 'A: B',
      tags: ['a', 'b']
    });
  });
});
