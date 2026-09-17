import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore, sessionContext, resume } from '../../../src/core';
import { formatOrientationBanner } from '../../../src/surfaces/kimi-code/orientation';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-kimi-orientation-'));
}

describe('Kimi Code orientation banner', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = tempProject();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('formats an empty project as a compact pointer', () => {
    const core = createMdocsCore(projectDir);
    const banner = formatOrientationBanner(sessionContext(core));

    expect(banner).toContain('## mdocs orientation');
    expect(banner).toContain('0 initiatives');
    expect(banner).toContain('workflow step: IDLE');
    expect(banner).toContain('Wiki pages: 0');
    expect(banner).toContain('mdocs_status');
  });

  test('includes active initiative title and id', async () => {
    const core = createMdocsCore(projectDir);
    const init = await core.commands.execute('initiative.create', {
      id: 'kimi-orientation-test',
      title: 'Kimi orientation test',
      objective: 'Verify the banner'
    });
    expect(init.success).toBe(true);
    const resumed = resume(core, 'kimi-orientation-test');
    expect(resumed.initiative?.id).toBe('kimi-orientation-test');
    expect(resumed.currentStep).toBe('UNDERSTAND');

    const banner = formatOrientationBanner(sessionContext(core));
    expect(banner).toContain('1 active');
    expect(banner).toContain('Kimi orientation test');
    expect(banner).toContain('kimi-orientation-test');
  });

  test('banner is a pointer, not a dump (stays compact)', () => {
    const core = createMdocsCore(projectDir);
    const banner = formatOrientationBanner(sessionContext(core));
    expect(banner.length).toBeLessThan(1000);
    expect(banner.split('\n').length).toBeLessThanOrEqual(8);
  });
});
