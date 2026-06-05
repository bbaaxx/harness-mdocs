export type Status = 'active' | 'paused' | 'done';

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
