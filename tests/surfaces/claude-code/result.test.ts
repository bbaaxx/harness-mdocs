import { toMcpResult, toMcpError } from '../../../src/surfaces/claude-code/result';

describe('Claude Code result.toMcpResult', () => {
  test('flags an {error} object with isError:true', () => {
    const r = toMcpResult({ error: 'Unsupported mdocs command: bogus' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Unsupported mdocs command');
  });

  test('does not flag a successful object', () => {
    const r = toMcpResult({ success: true, id: 'add-auth' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].type).toBe('text');
    expect(JSON.parse(r.content[0].text)).toEqual({ success: true, id: 'add-auth' });
  });

  test('does not flag a plain string', () => {
    const r = toMcpResult('all good');
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe('all good');
  });

  test('does not flag when error is not a string', () => {
    const r = toMcpResult({ error: 123 });
    expect(r.isError).toBeUndefined();
  });
});

describe('Claude Code result.toMcpError', () => {
  test('wraps a thrown Error with isError:true', () => {
    const r = toMcpError(new Error('boom'));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ error: 'boom' });
  });

  test('wraps a non-Error value', () => {
    const r = toMcpError('string failure');
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ error: 'string failure' });
  });
});
