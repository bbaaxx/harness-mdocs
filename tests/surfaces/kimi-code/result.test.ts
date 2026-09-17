import { toMcpResult, toMcpError } from '../../../src/surfaces/kimi-code/result';

describe('Kimi Code result translation', () => {
  test('wraps a success value as text content', () => {
    const result = toMcpResult({ success: true });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }]);
  });

  test('flags { error } results with isError: true', () => {
    const result = toMcpResult({ error: 'Initiative not found' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Initiative not found');
  });

  test('passes through string values verbatim', () => {
    const result = toMcpResult('plain text');
    expect(result.content[0].text).toBe('plain text');
  });

  test('toMcpError wraps a thrown error', () => {
    const result = toMcpError(new Error('boom'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
  });
});
