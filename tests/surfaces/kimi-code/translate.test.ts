import {
  translateToolName,
  translateArgs,
  parseHookStdin,
  toCore
} from '../../../src/surfaces/kimi-code/translate';

describe('Kimi Code translate.translateToolName', () => {
  test('maps every documented Kimi Code tool name to its core lowercase equivalent', () => {
    expect(translateToolName('Read')).toBe('read');
    expect(translateToolName('Write')).toBe('write');
    expect(translateToolName('Edit')).toBe('edit');
    expect(translateToolName('Grep')).toBe('grep');
    expect(translateToolName('Glob')).toBe('glob');
    expect(translateToolName('Bash')).toBe('bash');
    expect(translateToolName('Agent')).toBe('task');
    expect(translateToolName('AgentSwarm')).toBe('task');
    expect(translateToolName('Task')).toBe('task');
  });

  test('maps cross-version aliases kept for robustness', () => {
    expect(translateToolName('LS')).toBe('list');
    expect(translateToolName('List')).toBe('list');
    expect(translateToolName('MultiEdit')).toBe('edit');
    expect(translateToolName('NotebookEdit')).toBe('edit');
  });

  test('lowercases unknown tool names verbatim', () => {
    expect(translateToolName('SomeFutureTool')).toBe('somefuturetool');
    expect(translateToolName('ReadMediaFile')).toBe('readmediafile');
    expect(translateToolName('')).toBe('');
  });
});

describe('Kimi Code translate.translateArgs', () => {
  test('maps Kimi snake_case keys to core camelCase keys', () => {
    expect(translateArgs({
      path: '/a/b.ts',
      old_string: 'x',
      new_string: 'y',
      replace_all: true
    })).toEqual({
      path: '/a/b.ts',
      oldString: 'x',
      newString: 'y',
      replaceAll: true
    });
  });

  test('maps file_path to filePath (forward-compat with Claude-style clients)', () => {
    expect(translateArgs({ file_path: '/a/b.ts' })).toEqual({ filePath: '/a/b.ts' });
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

describe('Kimi Code translate.parseHookStdin', () => {
  test('parses a valid payload', () => {
    const parsed = parseHookStdin('{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"path":"/x"}}');
    expect(parsed).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Write' });
  });

  test('returns null on malformed JSON', () => {
    expect(parseHookStdin('not json')).toBeNull();
    expect(parseHookStdin('')).toBeNull();
  });

  test('returns null on non-object JSON', () => {
    expect(parseHookStdin('"string"')).toBeNull();
    expect(parseHookStdin('42')).toBeNull();
  });
});

describe('Kimi Code translate.toCore', () => {
  test('translates a full PreToolUse payload', () => {
    const { toolName, toolArgs } = toCore({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { path: '/repo/src/app.ts', content: 'x' },
      cwd: '/repo'
    });
    expect(toolName).toBe('write');
    expect(toolArgs).toEqual({ path: '/repo/src/app.ts', content: 'x' });
  });

  test('tolerates a payload missing tool_name and tool_input', () => {
    const { toolName, toolArgs } = toCore({});
    expect(toolName).toBe('');
    expect(toolArgs).toEqual({});
  });
});
