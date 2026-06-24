export type Status = 'active' | 'paused' | 'done' | 'complete' | 'archived';

/**
 * True for any status that means "completed".
 * `done` is the flat-v1 alias; `complete` is the directory-v2 canonical value.
 * Both surface the same semantic completion state.
 *
 * Accepts a raw `string` in addition to `Status` because some callers (e.g. the
 * linter) hold initiative status as an untyped string; the comparison only
 * ever matches the two completed values, so unknown strings simply return false.
 */
export function isCompleted(status: Status | string): boolean {
  return status === 'done' || status === 'complete';
}

export type StepName = 
  | 'IDLE' 
  | 'UNDERSTAND' 
  | 'DISCOVER' 
  | 'CONTEXT' 
  | 'PLAN' 
  | 'EXECUTE' 
  | 'VERIFY' 
  | 'REPORT' 
  | 'COMPLETE';

export type PlanItemStatus = 'pending' | 'in-progress' | 'done';

export interface PlanItem {
  description: string;
  status: PlanItemStatus;
  startedAt?: string;
  completedAt?: string;
}

export type Priority = 'critical' | 'high' | 'medium' | 'low';

export interface Initiative {
  id: string;
  title: string;
  status: Status;
  priority?: Priority;
  created: string;
  updated: string;
  owner: string;
  tags: string[];
  relatedWiki: string[];
  objective: string;
  plan: PlanItem[];
  progressLog: string[];
  artifacts: string[];
  dueDate?: string;
  dependsOn?: string[];
  phase?: 'discovery' | 'planning' | 'implementation' | 'verification' | 'done';
  handoffSummary?: string;
  openQuestions?: string[];
  blockers?: string[];
  nextAction?: string;
  /**
   * Optional expected-duration bucket. `suppress` opts an initiative out of
   * overdue enforcement; `long` widens the normal cadence expectations.
   * Set via initiative.create / initiative.update.
   */
  expectedDuration?: 'normal' | 'long' | 'suppress';
  /**
   * ISO date the initiative was graduated via `lifecycle.graduate` (Slice C).
   * Empty/absent for un-graduated initiatives.
   */
  graduated?: string;
}

export interface WikiEntry {
  id: string;
  title: string;
  category: string;
  created: string;
  updated: string;
  relatedInitiatives: string[];
  tags: string[];
  content: string;
  lifecycle?: 'draft' | 'stable' | 'superseded' | 'needs-review';
  knowledgeType?: 'architecture' | 'decision' | 'how-to' | 'reference' | 'roadmap' | 'note';
  confidence?: 'low' | 'medium' | 'high';
  sourceInitiatives?: string[];
  supersedes?: string[];
  relatedWiki?: string[];
}

export interface WorkflowState {
  currentStep: StepName;
  activeInitiative: string | null;
  stepHistory: { step: StepName; timestamp: string }[];
}

export interface LintIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
}

export interface LintResult {
  file: string;
  type: 'initiative' | 'wiki';
  score: number;
  issues: LintIssue[];
  passed: boolean;
}

export interface SearchResult {
  type: 'initiative' | 'wiki';
  id: string;
  title: string;
  score: number;
  snippet?: string;
  matchedFields?: string[];
}

export interface SearchOptions {
  tags?: string[];
  status?: string;
  category?: string;
  dateFrom?: string;
  dateTo?: string;
}

export type WikiIngestOp =
  | { type: 'createPage'; category: string; id: string; title: string; content?: string; tags?: string[]; relatedInitiatives?: string[]; lifecycle?: WikiEntry['lifecycle']; knowledgeType?: WikiEntry['knowledgeType']; confidence?: WikiEntry['confidence'] }
  | { type: 'updatePage'; category: string; id: string; content?: string; lifecycle?: WikiEntry['lifecycle']; tags?: string[]; relatedInitiatives?: string[] }
  | { type: 'updateOverviewSection'; section: string; body: string }
  | { type: 'appendLog'; entry: { timestamp?: string; date?: string; operation?: string; subject?: string; content: string } | string }
  | { type: 'link'; initiativeId: string; wikiSlug: string };

export interface AuditEvent {
  timestamp: string;
  type: 'tool' | 'workflow' | 'initiative' | 'wiki';
  initiativeId?: string;
  step?: StepName;
  details: Record<string, any>;
}

/**
 * Parse a YAML frontmatter value that may be JSON (`["a","b"]`) or
 * YAML inline array (`[a, b, c]`) or a plain scalar.
 */
export function parseYamlValue(raw: string): any {
  const trimmed = raw.trim();
  if (trimmed === '') return '';

  // 1. Try JSON first (covers quoted arrays, numbers, booleans, null)
  try {
    return JSON.parse(trimmed);
  } catch {
    // not valid JSON – continue
  }

  // 2. YAML inline array: [item1, item2, ...]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
  }

  // 3. Plain scalar
  // Strip surrounding quotes if present
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

/**
 * Parse YAML frontmatter lines into a key-value map.
 * Handles both JSON-style values and YAML inline arrays.
 */
export function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const front: Record<string, any> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) {
      front[key] = parseYamlValue(value);
    }
  }
  return front;
}

/**
 * Read an initiative's expected-duration frontmatter value across the
 * supported key spellings: snake_case `expected_duration`, camelCase
 * `expectedDuration`, and the hyphenated consumer form `expected-duration`.
 * Returns `undefined` when none are present. Centralized so lifecycle and lint
 * logic honors the consumer schema without each caller re-implementing the
 * lookup.
 */
export function readExpectedDurationRaw(front: Record<string, any>): any {
  return front.expected_duration ?? front.expectedDuration ?? front['expected-duration'];
}
