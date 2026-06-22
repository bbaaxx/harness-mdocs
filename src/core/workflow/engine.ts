import * as fs from 'fs';
import * as path from 'path';
import { WorkflowState, StepName } from '../types';

export const STEPS: StepName[] = [
  'IDLE', 'UNDERSTAND', 'DISCOVER', 'CONTEXT', 'PLAN',
  'EXECUTE', 'VERIFY', 'REPORT', 'COMPLETE'
];

/**
 * Bash commands treated as destructive and therefore gated to COMPLETE.
 * Deliberately a BLACKLIST (not a safe-list): build/test tooling (npm, node,
 * tsc, jest, npx, read-only git) must run at VERIFY, so the gate cannot rely on
 * enumerating every safe command. Matches the documented destructive set:
 * delete/move (rm, rmdir, mv), force copy (cp -f), git state mutations
 * (commit/push/reset/clean/rm, checkout --/.), publish, and disk wipes.
 *
 * File-overwrite redirection (> / >>) is intentionally NOT treated as
 * destructive: detecting it reliably via regex is impossible (echo labels like
 * "PLAN->COMPLETE", shell arrows, 2>&1 merges all produce false positives that
 * lock out legitimate work), and the cost of those lockouts exceeds the value.
 * Everything outside this list is allowed at any non-IDLE step.
 */
const DESTRUCTIVE_BASH = /\b(rm|rmdir|mv)\b|\bcp\b[^|\n]*\s-f\b|\bgit\s+(commit|push|reset|clean|rm)\b|\bgit\s+checkout\s+(--|\.)|\bnpm\s+publish\b|\b(mkfs|dd|shred)\b/i;

export class WorkflowEngine {
  private statePath: string;
  private state: WorkflowState;

  constructor(baseDir: string) {
    this.statePath = path.join(baseDir, '.workflow-state.json');
    this.state = this.load();
  }

  private load(): WorkflowState {
    if (fs.existsSync(this.statePath)) {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    }
    return {
      currentStep: 'IDLE',
      activeInitiative: null,
      stepHistory: []
    };
  }

  private save(): void {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  getCurrentStep(): StepName {
    return this.state.currentStep;
  }

  advance(nextStep: StepName): void {
    const currentIndex = STEPS.indexOf(this.state.currentStep);
    const nextIndex = STEPS.indexOf(nextStep);
    
    if (nextIndex < currentIndex) {
      throw new Error(`Cannot go back from ${this.state.currentStep} to ${nextStep}`);
    }
    if (nextIndex > currentIndex + 1) {
      throw new Error(`Cannot skip from ${this.state.currentStep} to ${nextStep}`);
    }

    this.state.stepHistory.push({
      step: nextStep,
      timestamp: new Date().toISOString()
    });
    this.state.currentStep = nextStep;
    this.save();
  }

  private isMdocsOperation(toolName: string, toolArgs?: Record<string, any>): boolean {
    // Check if any path argument references the mdocs directory
    const args = toolArgs || {};
    
    const isMdocsPath = (p: string): boolean => {
      // Match both absolute (/mdocs/) and relative (mdocs/) paths
      // Also handle Windows paths (\mdocs\)
      return p.includes('/mdocs/') || 
             p.includes('\\mdocs\\') || 
             p.startsWith('mdocs/') || 
             p.startsWith('mdocs\\');
    };
    
    // Direct file paths (read, write, edit tools)
    if (args.filePath && typeof args.filePath === 'string' && isMdocsPath(args.filePath)) {
      return true;
    }
    
    // Path parameter (glob, grep, list tools)
    if (args.path && typeof args.path === 'string' && isMdocsPath(args.path)) {
      return true;
    }
    
    // Pattern parameter (glob, grep tools)
    if (args.pattern && typeof args.pattern === 'string' && isMdocsPath(args.pattern)) {
      return true;
    }
    
    // Bash commands operating on mdocs
    if (toolName === 'bash') {
      const command = args.command || args.args?.command || '';
      if (typeof command === 'string' && isMdocsPath(command)) {
        return true;
      }
    }
    
    return false;
  }

  canExecuteTool(toolName: string, toolArgs?: Record<string, any>): boolean {
    const readTools = ['read', 'glob', 'grep', 'list'];
    const writeTools = ['edit', 'write'];

    // Allow unrestricted access to mdocs knowledge files regardless of workflow step
    if (this.isMdocsOperation(toolName, toolArgs)) {
      return true;
    }

    if (readTools.includes(toolName)) return true;
    if (this.state.currentStep === 'IDLE') return true;
    if (writeTools.includes(toolName)) {
      return ['PLAN', 'EXECUTE', 'VERIFY', 'REPORT', 'COMPLETE'].includes(this.state.currentStep);
    }
    if (toolName === 'bash') {
      // Destructive ops (rm, git commit, publish, overwrite redirects, ...) require
      // COMPLETE. Build/test tooling is non-destructive and may run at VERIFY so
      // verification is reachable before completion.
      const command = toolArgs?.command || toolArgs?.args?.command || '';
      if (DESTRUCTIVE_BASH.test(command)) {
        return this.state.currentStep === 'COMPLETE';
      }
      return true;
    }
    return true;
  }

  status(): WorkflowState {
    return this.state;
  }

  setActiveInitiative(initiativeId: string | null): void {
    this.state.activeInitiative = initiativeId;
    this.save();
  }

  resumeAt(step: StepName): void {
    this.state.currentStep = step;
    this.state.stepHistory.push({ step, timestamp: new Date().toISOString() });
    this.save();
  }
}
