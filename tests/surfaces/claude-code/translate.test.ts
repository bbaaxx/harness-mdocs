import {
  translateToolName,
  translateArgs,
  parseHookStdin,
  toCore
} from '../../../src/surfaces/claude-code/translate';

describe('Claude Code translate.translateToolName', () => {
  test('maps every Claude Code tool name to its core lowercase equivalent', () => {
    expect(translateToolName('Read')).toBe('read');
    expect(translateToolName('Glob')).toBe('glob');
    expect(translateToolName('Grep')).toBe('grep');
    expect(translateToolName('LS')).toBe('list');
    expect(translateToolName('List')).toBe('list');
    expect(translateToolName('Write')).toBe('write');
    expect(translateToolName('Edit')).toBe('edit');
    expect(translateToolName('MultiEdit')).toBe('edit');
    expect(translateToolName('NotebookEdit')).toBe('edit');
    expect(translateToolName('Bash')).toBe('bash');
    expect(translateToolName('Task')).toBe('task');
    expect(translateToolName('Agent')).toBe('task');
  });

  test('lowercases unknown tool names verbatim', () => {
    expect(translateToolName('SomeFutureTool')).toBe('somefuturetool');
    expect(translateToolName('')).toBe('');
  });
});

describe('Claude Code translate.translateArgs', () => {
  test('maps file_path to filePath', () => {
    expect(translateArgs({ file_path: '/a/b.ts' })).toEqual({ filePath: '/a/b.ts' });
  });

  test('maps notebook_path to filePath', () => {
    expect(translateArgs({ notebook_path: '/a/nb.ipynb' })).toEqual({ filePath: '/a/nb.ipynb' });
  });

  test('preserves known passthrough keys', () => {
    expect(translateArgs({ path: 'mdocs/', pattern: '*.ts', command: 'ls' })).toEqual({
      path: 'mdocs/',
      pattern: '*.ts',
      command: 'ls'
    });
  });

  test('preserves unknown keys verbatim', () => {
    expect(translateArgs({ weird_key: 1 })).toEqual({ weird_key: 1 });
  });

  test('returns empty object for undefined input', () => {
    expect(translateArgs(undefined)).toEqual({});
  });
});

describe('Claude Code translate.parseHookStdin', () => {
  test('parses a valid payload', () => {
    const parsed = parseHookStdin('{"tool_name":"Write","tool_input":{"file_path":"/x"}}');
    expect(parsed).toMatchObject({ tool_name: 'Write' });
  });

  test('returns null on malformed JSON', () => {
    expect(parseHookStdin('{not json')).toBeNull();
    expect(parseHookStdin('')).toBeNull();
  });

  test('returns null when JSON is not an object', () => {
    expect(parseHookStdin('42')).toBeNull();
    expect(parseHookStdin('"a string"')).toBeNull();
    expect(parseHookStdin('null')).toBeNull();
  });
});

describe('Claude Code translate.toCore', () => {
  test('translates a full payload into core toolName + toolArgs', () => {
    expect(
      toCore({ tool_name: 'Write', tool_input: { file_path: '/src/a.ts', content: 'x' } })
    ).toEqual({ toolName: 'write', toolArgs: { filePath: '/src/a.ts', content: 'x' } });
  });

  test('handles a payload with no tool name', () => {
    expect(toCore({})).toEqual({ toolName: '', toolArgs: {} });
  });
});
