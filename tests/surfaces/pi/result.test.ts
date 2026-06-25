import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toPiToolResult, toPiToolError } from '../../../src/surfaces/pi/result';

describe('pi result.toPiToolResult', () => {
  test('flags an {error} object with isError:true', () => {
    const r = toPiToolResult({ error: 'Unsupported mdocs command: bogus' });
    expect(r.isError).toBe(true);
    expect(r.content[0].type).toBe('text');
    expect(r.content[0].text).toContain('Unsupported mdocs command');
    expect(r.details).toBeDefined();
  });

  test('does not flag a successful object', () => {
    const r = toPiToolResult({ success: true, id: 'add-auth' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual({ success: true, id: 'add-auth' });
    expect(r.details).toBeDefined();
  });

  test('does not flag a plain string', () => {
    const r = toPiToolResult('all good');
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe('all good');
  });

  test('does not flag when error is not a string', () => {
    const r = toPiToolResult({ error: 123 });
    expect(r.isError).toBeUndefined();
  });

  test('details is always present (pi AgentToolResult requires it)', () => {
    expect(toPiToolResult({ a: 1 }).details).toBeDefined();
    expect(toPiToolResult('x').details).toBeDefined();
    expect(toPiToolResult({ error: 'boom' }).details).toBeDefined();
  });
});

describe('pi result.toPiToolError', () => {
  test('wraps a thrown Error with isError:true', () => {
    const r = toPiToolError(new Error('boom'));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ error: 'boom' });
    expect(r.details).toBeDefined();
  });

  test('wraps a non-Error value', () => {
    const r = toPiToolError('string failure');
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ error: 'string failure' });
  });
});

/** Smoke check that the asset templates dir is resolvable from the compiled skills module. */
describe('pi result module loads', () => {
  test('tmp project write sanity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-pi-result-'));
    const f = path.join(dir, 'probe.txt');
    fs.writeFileSync(f, 'ok');
    expect(fs.readFileSync(f, 'utf8')).toBe('ok');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
