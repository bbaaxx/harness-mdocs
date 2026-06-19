import * as fs from 'fs';
import * as path from 'path';
import { LintResult, LintIssue, parseFrontmatter } from '../types';
import { normalizeInitiativeStatus } from '../initiative-store';

export class MdocsLinter {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  lintFile(filePath: string): LintResult {
    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(this.baseDir, filePath);
    
    if (filePath.includes('/initiatives/') || filePath.includes('\\initiatives\\')) {
      return this.lintInitiative(content, relativePath);
    }
    if (filePath.includes('/wiki/') || filePath.includes('\\wiki\\')) {
      return this.lintWiki(content, relativePath);
    }

    return {
      file: relativePath,
      type: 'initiative',
      score: 0,
      issues: [{ severity: 'error', message: 'File is not in initiatives/ or wiki/ directory' }],
      passed: false
    };
  }

  lintAll(): LintResult[] {
    const results: LintResult[] = [];
    const wikiDir = path.join(this.baseDir, 'wiki');

    for (const filePath of this.listInitiativeFiles()) {
      results.push(this.lintFile(filePath));
    }

    if (fs.existsSync(wikiDir)) {
      for (const filePath of this.rootWikiFiles()) {
        results.push(this.lintFile(filePath));
      }
      const categories = fs.readdirSync(wikiDir).filter(f => {
        if (f === '_obsidian') return false;
        const stat = fs.statSync(path.join(wikiDir, f));
        return stat.isDirectory();
      });
      for (const category of categories) {
        const catDir = path.join(wikiDir, category);
        const files = fs.readdirSync(catDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
        for (const f of files) {
          results.push(this.lintFile(path.join(catDir, f)));
        }
      }
    }

    results.push(...this.lintGraph());

    return results;
  }

  private lintGraph(): LintResult[] {
    const issues: LintIssue[] = [];
    const initiativesDir = path.join(this.baseDir, 'initiatives');
    const wikiDir = path.join(this.baseDir, 'wiki');

    // Collect all initiative data
    const initiativeData: { id: string; slug: string; status: string; relatedWiki: string[]; filePath: string }[] = [];
    for (const filePath of this.listInitiativeFiles()) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const front = parseFrontmatter(content);
        const relativePath = path.relative(initiativesDir, filePath);
        const slug = relativePath.endsWith('_status.md')
          ? relativePath.split(path.sep)[0]
          : path.basename(relativePath, '.md').replace(/--\d{4}-\d{2}-\d{2}$/, '');
        initiativeData.push({
          id: front.id || slug,
          slug,
          status: normalizeInitiativeStatus(front.status),
          relatedWiki: Array.isArray(front.related_wiki) ? front.related_wiki : [],
          filePath: relativePath
        });
      } catch { /* skip */ }
    }

    // Collect all wiki data
    const wikiData: { id: string; category: string; relatedInitiatives: string[]; sourceInitiatives: string[]; lifecycle?: string; filePath: string }[] = [];
    if (fs.existsSync(wikiDir)) {
      for (const filePath of this.rootWikiFiles()) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const front = parseFrontmatter(content);
          const stem = path.basename(filePath, '.md');
          wikiData.push({
            id: front.id || stem,
            category: front.category || '',
            relatedInitiatives: Array.isArray(front.related_initiatives) ? front.related_initiatives : [],
            sourceInitiatives: Array.isArray(front.source_initiatives) ? front.source_initiatives : Array.isArray(front.sources) ? front.sources : [],
            lifecycle: front.lifecycle,
            filePath: path.basename(filePath)
          });
        } catch { /* skip */ }
      }
      const categories = fs.readdirSync(wikiDir).filter(f => f !== '_obsidian' && fs.statSync(path.join(wikiDir, f)).isDirectory());
      for (const category of categories) {
        const catDir = path.join(wikiDir, category);
        const files = fs.readdirSync(catDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
        for (const f of files) {
          try {
            const content = fs.readFileSync(path.join(catDir, f), 'utf8');
            const front = parseFrontmatter(content);
            const id = front.id || f.replace('.md', '');
            wikiData.push({
              id,
              category: front.category || category,
              relatedInitiatives: Array.isArray(front.related_initiatives) ? front.related_initiatives : [],
              sourceInitiatives: Array.isArray(front.source_initiatives) ? front.source_initiatives : Array.isArray(front.sources) ? front.sources : [],
              lifecycle: front.lifecycle,
              filePath: `${category}/${f}`
            });
          } catch { /* skip */ }
        }
      }
    }

    const initiativeIds = new Set(initiativeData.flatMap(i => [i.id, i.slug]));
    const wikiRefs = new Set(wikiData.flatMap(w => [w.category ? `${w.category}/${w.id}` : w.id, w.id]));

    // Check initiative related_wiki
    for (const init of initiativeData) {
      for (const wikiRef of init.relatedWiki) {
        // Broken reference
        if (!wikiRefs.has(wikiRef)) {
          issues.push({
            severity: 'warning',
            message: `Initiative ${init.id} references missing wiki ${wikiRef}`
          });
        }
      }

      // Done initiative should have at least one stable wiki learning
      if (init.status === 'done') {
        const initRefs = new Set([init.id, init.slug]);
        const stableWikiLinks = init.relatedWiki.filter(ref => {
          const wikiEntry = wikiData.find(w => (w.category ? `${w.category}/${w.id}` : w.id) === ref || w.id === ref);
          return wikiEntry && wikiEntry.lifecycle === 'stable';
        });
        const stableSourceWiki = wikiData.some(wiki => wiki.lifecycle === 'stable' && wiki.sourceInitiatives.some(source => initRefs.has(source)));
        if (stableWikiLinks.length === 0 && !stableSourceWiki) {
          issues.push({
            severity: 'warning',
            message: `Done initiative ${init.id} has no stable wiki learning`
          });
        }
      }
    }

    // Check wiki related_initiatives and backlinks
    for (const wiki of wikiData) {
      // Broken initiative reference
      for (const initRef of wiki.relatedInitiatives) {
        if (!initiativeIds.has(initRef)) {
          issues.push({
            severity: 'warning',
            message: `Wiki ${wiki.category}/${wiki.id} references missing initiative ${initRef}`
          });
        }
      }
      for (const initRef of wiki.sourceInitiatives) {
        if (!initiativeIds.has(initRef)) {
          issues.push({
            severity: 'warning',
            message: `Wiki ${wiki.category}/${wiki.id} references missing initiative ${initRef}`
          });
        }
      }

      // Check backlinks: initiatives referencing this wiki should have this initiative in their backlinks
      for (const init of initiativeData) {
        const wikiRef = wiki.category ? `${wiki.category}/${wiki.id}` : wiki.id;
        if (init.relatedWiki.includes(wikiRef)) {
          // Initiative references this wiki entry - check if wiki has backlink
          if (!wiki.relatedInitiatives.includes(init.id) && !wiki.sourceInitiatives.includes(init.id) && !wiki.sourceInitiatives.includes(init.slug)) {
            issues.push({
              severity: 'warning',
              message: `Wiki ${wiki.category}/${wiki.id} missing backlink to initiative ${init.id}`
            });
          }
        }
      }
    }

    if (issues.length === 0) return [];

    return [{
      file: 'GRAPH',
      type: 'initiative',
      score: 0,
      issues,
      passed: false
    }];
  }

  private listInitiativeFiles(): string[] {
    const initiativesDir = path.join(this.baseDir, 'initiatives');
    if (!fs.existsSync(initiativesDir)) return [];

    const files: string[] = [];
    for (const entry of fs.readdirSync(initiativesDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'INDEX.md') {
        files.push(path.join(initiativesDir, entry.name));
      }
      if (entry.isDirectory() && entry.name !== 'archive' && entry.name !== '_archive') {
        const statusPath = path.join(initiativesDir, entry.name, '_status.md');
        if (fs.existsSync(statusPath)) files.push(statusPath);
      }
    }
    return files;
  }

  private rootWikiFiles(): string[] {
    const wikiDir = path.join(this.baseDir, 'wiki');
    if (!fs.existsSync(wikiDir)) return [];
    return fs.readdirSync(wikiDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'INDEX.md')
      .map(entry => path.join(wikiDir, entry.name));
  }

  private lintInitiative(content: string, filePath: string): LintResult {
    const issues: LintIssue[] = [];
    let score = 5;

    // Parse frontmatter
    const frontmatterMatch = content.match(/---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      if (path.dirname(filePath).split(path.sep).pop() === 'wiki') {
        return { file: filePath, type: 'wiki', score: 5, issues: [], passed: true };
      }
      issues.push({ severity: 'error', message: 'Missing YAML frontmatter' });
      score = 0;
      return { file: filePath, type: 'initiative', score, issues, passed: false };
    }

    const frontmatter = frontmatterMatch[1];
    const requiredFields = ['id', 'title', 'status', 'created', 'updated', 'tags'];
    for (const field of requiredFields) {
      if (!frontmatter.includes(`${field}:`)) {
        issues.push({ severity: 'error', message: `Missing required frontmatter field: ${field}` });
        score -= 1;
      }
    }

    // Parse body
    const body = content.replace(/---\n[\s\S]*?\n---/, '').trim();

    // Check Objective
    const objectiveMatch = body.match(/## Objective\n([\s\S]*?)(?=\n## |$)/);
    const objective = objectiveMatch ? objectiveMatch[1].trim() : '';
    if (!objective || objective.length < 10) {
      issues.push({ severity: 'error', message: 'Objective missing or too short (min 10 words)' });
      score -= 1;
    }

    // Check Plan items are concrete
    const planMatch = body.match(/## Plan\n([\s\S]*?)(?=\n## |$)/);
    const planSection = planMatch ? planMatch[1].trim() : '';
    const planItems = planSection.split('\n').filter(line => line.trim().startsWith('- '));
    if (planItems.length === 0) {
      issues.push({ severity: 'error', message: 'Plan section is empty' });
      score -= 1;
    } else {
      for (const item of planItems) {
        const text = item.replace(/^- \[[ x/]\] /, '').replace(/^- /, '').trim();
        const vaguePrefixes = ['research how', 'investigate', 'look into', 'explore', 'learn about', 'find out', 'check if'];
        if (vaguePrefixes.some(prefix => text.toLowerCase().startsWith(prefix))) {
          issues.push({ severity: 'warning', message: `Vague plan item detected: "${text}"` });
          score -= 0.5;
        }
      }
    }

    // Check for file paths or Context section
    const hasContextSection = /## Context/.test(body);
    const hasFilePaths = /\b(src\/[\w/]+\.(ts|js|md)|templates\/|agents\/|skills\/)/.test(body);
    const hasPlanPaths = planItems.some(item => /\b(src\/[\w/]+|templates\/|agents\/|skills\/)/.test(item));
    if (!hasContextSection && !hasFilePaths && !hasPlanPaths) {
      issues.push({ severity: 'error', message: 'No file paths or Context section found — fresh agent won\'t know where to edit' });
      score -= 2;
    }

    // Check Acceptance Criteria
    const hasAcceptanceCriteria = /## Acceptance Criteria|done when|acceptance/i.test(body);
    if (!hasAcceptanceCriteria) {
      issues.push({ severity: 'warning', message: 'Missing Acceptance Criteria section or "Done when" statements' });
      score -= 0.5;
    }

    // Check Progress Log exists
    const hasProgressLog = /## Progress Log/.test(body);
    if (!hasProgressLog) {
      issues.push({ severity: 'warning', message: 'Missing Progress Log section' });
      score -= 0.5;
    }

    // Normalize score to 0-5
    score = Math.max(0, Math.min(5, score));
    const passed = score >= 4;

    return { file: filePath, type: 'initiative', score, issues, passed };
  }

  private lintWiki(content: string, filePath: string): LintResult {
    const issues: LintIssue[] = [];
    let score = 5;

    // Parse frontmatter
    const frontmatterMatch = content.match(/---\n([\s\S]*?)\n---/);
    const isRootWiki = path.dirname(filePath).split(path.sep).pop() === 'wiki';
    if (!frontmatterMatch) {
      if (isRootWiki) {
        return { file: filePath, type: 'wiki', score: 5, issues, passed: true };
      }
      issues.push({ severity: 'error', message: 'Missing YAML frontmatter' });
      score = 0;
      return { file: filePath, type: 'wiki', score, issues, passed: false };
    }

    const frontmatter = frontmatterMatch[1];
    const requiredFields = isRootWiki ? ['id', 'title'] : ['id', 'title', 'category', 'created', 'updated', 'tags'];
    for (const field of requiredFields) {
      if (!frontmatter.includes(`${field}:`)) {
        issues.push({ severity: 'error', message: `Missing required frontmatter field: ${field}` });
        score -= 1;
      }
    }

    // Parse body
    const body = content.replace(/---\n[\s\S]*?\n---/, '').trim();

    // Check content length
    const wordCount = body.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount < 50) {
      issues.push({ severity: 'warning', message: `Content is short (${wordCount} words, min recommended 50)` });
      score -= 1;
    }

    // Check category matches directory
    const categoryMatch = frontmatter.match(/category:\s*"?([^"\n]+)"?/);
    if (categoryMatch) {
      const category = categoryMatch[1].trim();
      const expectedDir = path.dirname(filePath).split(path.sep).pop();
      if (!isRootWiki && category !== expectedDir) {
        issues.push({ severity: 'warning', message: `Category "${category}" does not match directory "${expectedDir}"` });
        score -= 0.5;
      }
    }

    // Check related initiatives
    if (!frontmatter.includes('related_initiatives:')) {
      issues.push({ severity: 'info', message: 'No related_initiatives linked (ok for standalone docs)' });
    }

    score = Math.max(0, Math.min(5, score));
    const passed = score >= 4;

    return { file: filePath, type: 'wiki', score, issues, passed };
  }
}
