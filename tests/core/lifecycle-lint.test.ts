import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MdocsLinter } from '../../src/core/validation/linter';

// ---------- helpers ----------

/**
 * ISO date string (YYYY-MM-DD) for `daysFromNow` days before today.
 * Negative values produce a future date.
 */
function isoDaysAgo(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysFromNow);
  return d.toISOString().slice(0, 10);
}

/** Minimal valid initiative body that passes the existing quality rules. */
const VALID_BODY = `
## Objective
This is a sufficiently detailed objective that explains the work and why it matters for the project.

## Plan
- [ ] Implement feature in src/core/feature.ts
- [ ] Add tests in src/core/feature.test.ts

## Progress Log
- started

## Artifacts
- wiki/decisions/feature.md

## Acceptance Criteria
- All tests pass
`;

interface InitiativeOpts {
  status?: string;
  created?: string;
  started?: string;
  updated?: string;
  completed?: string;
  graduated?: string;
  expectedDuration?: string; // written as expected_duration: <value>
}

/** Build a flat-v1 initiative markdown string with the given lifecycle fields. */
function initiativeMarkdown(id: string, opts: InitiativeOpts = {}): string {
  const today = isoDaysAgo(0);
  const lines = [
    '---',
    `id: ${id}`,
    `title: ${id} Initiative`,
    `status: ${opts.status ?? 'active'}`,
  ];
  if (opts.created) lines.push(`created: ${opts.created}`);
  if (opts.started) lines.push(`started: ${opts.started}`);
  if (opts.updated) lines.push(`updated: ${opts.updated}`);
  if (opts.completed) lines.push(`completed: ${opts.completed}`);
  if (opts.graduated) lines.push(`graduated: ${opts.graduated}`);
  if (opts.expectedDuration) lines.push(`expected_duration: ${opts.expectedDuration}`);
  lines.push('tags: [lifecycle]', 'related_wiki: []', '---', '', VALID_BODY);
  return lines.join('\n');
}

function makeProjectDir(prefix: string): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(projectDir, 'mdocs', 'initiatives'), { recursive: true });
  return projectDir;
}

function writeInitiative(projectDir: string, id: string, content: string): string {
  const filePath = path.join(projectDir, 'mdocs', 'initiatives', `${id}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function lint(projectDir: string, filePath: string) {
  return new MdocsLinter(path.join(projectDir, 'mdocs')).lintFile(filePath);
}

function hasWarning(messages: string[], needle: string): boolean {
  return messages.some(m => m.includes(needle));
}

// ---------- 1. long-running-active ----------

describe('long-running-active', () => {
  test('fires for an active initiative older than the default 14-day threshold', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-lra-fire-');
    const filePath = writeInitiative(
      projectDir,
      'lra-fire',
      initiativeMarkdown('lra-fire', { created: isoDaysAgo(20), updated: isoDaysAgo(20) }),
    );
    const result = lint(projectDir, filePath);
    expect(hasWarning(result.issues.map(i => i.message), 'long-running-active')).toBe(true);
  });

  test('does not fire when expected_duration:long and under 60 days', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-lra-long-');
    const filePath = writeInitiative(
      projectDir,
      'lra-long',
      initiativeMarkdown('lra-long', {
        created: isoDaysAgo(20),
        updated: isoDaysAgo(20),
        expectedDuration: 'long',
      }),
    );
    const result = lint(projectDir, filePath);
    expect(hasWarning(result.issues.map(i => i.message), 'long-running-active')).toBe(false);
  });

  test('does not fire when expected_duration:suppress even at 100 days', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-lra-suppress-');
    const filePath = writeInitiative(
      projectDir,
      'lra-suppress',
      initiativeMarkdown('lra-suppress', {
        created: isoDaysAgo(100),
        updated: isoDaysAgo(100),
        expectedDuration: 'suppress',
      }),
    );
    const result = lint(projectDir, filePath);
    expect(hasWarning(result.issues.map(i => i.message), 'long-running-active')).toBe(false);
  });
});

// ---------- 2. stale-complete ----------

describe('stale-complete', () => {
  test('fires when completed more than 30 days ago and not archived', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-stale-');
    const filePath = writeInitiative(
      projectDir,
      'stale-complete',
      initiativeMarkdown('stale-complete', {
        status: 'complete',
        created: isoDaysAgo(50),
        updated: isoDaysAgo(40),
        completed: isoDaysAgo(40),
      }),
    );
    const result = lint(projectDir, filePath);
    expect(hasWarning(result.issues.map(i => i.message), 'stale-complete')).toBe(true);
  });

  test('does not fire when completed only 5 days ago', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-stale-fresh-');
    const filePath = writeInitiative(
      projectDir,
      'stale-fresh',
      initiativeMarkdown('stale-fresh', {
        status: 'complete',
        created: isoDaysAgo(10),
        updated: isoDaysAgo(5),
        completed: isoDaysAgo(5),
      }),
    );
    const result = lint(projectDir, filePath);
    expect(hasWarning(result.issues.map(i => i.message), 'stale-complete')).toBe(false);
  });

  test('does not fire when status is archived', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-stale-archived-');
    const filePath = writeInitiative(
      projectDir,
      'stale-archived',
      initiativeMarkdown('stale-archived', {
        status: 'archived',
        created: isoDaysAgo(50),
        updated: isoDaysAgo(40),
        completed: isoDaysAgo(40),
      }),
    );
    const result = lint(projectDir, filePath);
    expect(hasWarning(result.issues.map(i => i.message), 'stale-complete')).toBe(false);
  });
});

// ---------- 3. graduation-due ----------

describe('graduation-due', () => {
  test('fires when done and not graduated after 7 days', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-grad-due-');
    const filePath = writeInitiative(
      projectDir,
      'grad-due',
      initiativeMarkdown('grad-due', {
        status: 'done',
        created: isoDaysAgo(20),
        updated: isoDaysAgo(10),
        completed: isoDaysAgo(10),
      }),
    );
    const result = lint(projectDir, filePath);
    expect(hasWarning(result.issues.map(i => i.message), 'graduation-due')).toBe(true);
  });

  test('does not fire when graduated is set', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-grad-done-');
    const filePath = writeInitiative(
      projectDir,
      'grad-done',
      initiativeMarkdown('grad-done', {
        status: 'done',
        created: isoDaysAgo(20),
        updated: isoDaysAgo(10),
        completed: isoDaysAgo(10),
        graduated: isoDaysAgo(8),
      }),
    );
    const result = lint(projectDir, filePath);
    expect(hasWarning(result.issues.map(i => i.message), 'graduation-due')).toBe(false);
  });
});

// ---------- 4. score is unaffected ----------

describe('score is unaffected by lifecycle warnings', () => {
  test('a long-running-active initiative still passes with score 5', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-score-');
    const filePath = writeInitiative(
      projectDir,
      'score-unaffected',
      initiativeMarkdown('score-unaffected', { created: isoDaysAgo(20), updated: isoDaysAgo(20) }),
    );
    const result = lint(projectDir, filePath);

    // The lifecycle warning is present...
    expect(hasWarning(result.issues.map(i => i.message), 'long-running-active')).toBe(true);
    // ...yet the initiative still passes at full score.
    expect(result.passed).toBe(true);
    expect(result.score).toBe(5);
  });

  test('a stale-complete initiative still passes at full score', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-score-complete-');
    const filePath = writeInitiative(
      projectDir,
      'score-complete',
      initiativeMarkdown('score-complete', {
        status: 'complete',
        created: isoDaysAgo(50),
        updated: isoDaysAgo(40),
        completed: isoDaysAgo(40),
      }),
    );
    const result = lint(projectDir, filePath);

    expect(hasWarning(result.issues.map(i => i.message), 'stale-complete')).toBe(true);
    expect(hasWarning(result.issues.map(i => i.message), 'graduation-due')).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(5);
  });
});

// ---------- 5. clears after remediation ----------

describe('warnings clear after remediation', () => {
  test('long-running-active clears when expected_duration becomes suppress', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-clear-lra-');
    const filePath = writeInitiative(
      projectDir,
      'clear-lra',
      initiativeMarkdown('clear-lra', { created: isoDaysAgo(20), updated: isoDaysAgo(20) }),
    );
    expect(hasWarning(lint(projectDir, filePath).issues.map(i => i.message), 'long-running-active')).toBe(true);

    // Remediate: set expected_duration: suppress
    fs.writeFileSync(
      filePath,
      initiativeMarkdown('clear-lra', {
        created: isoDaysAgo(20),
        updated: isoDaysAgo(20),
        expectedDuration: 'suppress',
      }),
      'utf8',
    );
    expect(hasWarning(lint(projectDir, filePath).issues.map(i => i.message), 'long-running-active')).toBe(false);
  });

  test('graduation-due clears when graduated is set', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-clear-grad-');
    const filePath = writeInitiative(
      projectDir,
      'clear-grad',
      initiativeMarkdown('clear-grad', {
        status: 'done',
        created: isoDaysAgo(20),
        updated: isoDaysAgo(10),
        completed: isoDaysAgo(10),
      }),
    );
    expect(hasWarning(lint(projectDir, filePath).issues.map(i => i.message), 'graduation-due')).toBe(true);

    fs.writeFileSync(
      filePath,
      initiativeMarkdown('clear-grad', {
        status: 'done',
        created: isoDaysAgo(20),
        updated: isoDaysAgo(10),
        completed: isoDaysAgo(10),
        graduated: isoDaysAgo(2),
      }),
      'utf8',
    );
    expect(hasWarning(lint(projectDir, filePath).issues.map(i => i.message), 'graduation-due')).toBe(false);
  });

  test('stale-complete clears when status changes to archived', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-clear-stale-');
    const filePath = writeInitiative(
      projectDir,
      'clear-stale',
      initiativeMarkdown('clear-stale', {
        status: 'complete',
        created: isoDaysAgo(50),
        updated: isoDaysAgo(40),
        completed: isoDaysAgo(40),
      }),
    );
    expect(hasWarning(lint(projectDir, filePath).issues.map(i => i.message), 'stale-complete')).toBe(true);

    fs.writeFileSync(
      filePath,
      initiativeMarkdown('clear-stale', {
        status: 'archived',
        created: isoDaysAgo(50),
        updated: isoDaysAgo(40),
        completed: isoDaysAgo(40),
      }),
      'utf8',
    );
    expect(hasWarning(lint(projectDir, filePath).issues.map(i => i.message), 'stale-complete')).toBe(false);
  });
});

// ---------- 6. hyphenated expected-duration (cc2 consumer schema) ----------

describe('expected-duration consumer spellings', () => {
  test('long-running-active honors hyphenated expected-duration:long threshold', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-hyphen-long-');
    // Build a consumer-schema initiative manually: body is intentionally thin
    // because a metadata-only linter never reaches the body-section checks.
    const lines = [
      '---',
      'id: hyphen-long',
      'status: active',
      `created: ${isoDaysAgo(40)}`,
      'expected-duration: long',
      '---',
      '',
      'Thin consumer record.',
    ];
    const filePath = path.join(projectDir, 'mdocs', 'initiatives', 'hyphen-long.md');
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

    const result = new MdocsLinter(path.join(projectDir, 'mdocs'), {
      initiativeRecordMode: 'metadata-only',
    }).lintFile(filePath);
    const messages = result.issues.map(i => i.message);

    // 40 days is under the 60-day `long` window, so the warning must NOT fire.
    expect(hasWarning(messages, 'long-running-active')).toBe(false);
    // And the metadata-only record still passes despite no body sections.
    expect(result.passed).toBe(true);
  });

  test('long-running-active fires past the default window with hyphenated expected-duration absent', () => {
    const projectDir = makeProjectDir('harness-mdocs-lifecycle-lint-hyphen-fire-');
    const lines = [
      '---',
      'id: hyphen-fire',
      'status: active',
      `created: ${isoDaysAgo(40)}`,
      '---',
      '',
      'Thin consumer record.',
    ];
    const filePath = path.join(projectDir, 'mdocs', 'initiatives', 'hyphen-fire.md');
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

    const result = new MdocsLinter(path.join(projectDir, 'mdocs'), {
      initiativeRecordMode: 'metadata-only',
    }).lintFile(filePath);
    const messages = result.issues.map(i => i.message);

    // No expected-duration key at all -> default 14-day threshold -> 40 days fires.
    expect(hasWarning(messages, 'long-running-active')).toBe(true);
    // Lifecycle warnings carry no score deduction.
    expect(result.score).toBe(5);
    expect(result.passed).toBe(true);
  });
});
