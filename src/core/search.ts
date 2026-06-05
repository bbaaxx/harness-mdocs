import * as fs from 'fs';
import * as path from 'path';
import { SearchResult, SearchOptions } from './types';
import { InitiativeManager } from './managers/initiative';
import { WikiManager } from './managers/wiki';

/**
 * In-memory inverted index for full-text search across initiatives and wiki.
 * Rebuilds index on demand by scanning the file system.
 */
export class SearchEngine {
  private baseDir: string;
  private initiatives: InitiativeManager;
  private wiki: WikiManager;

  // term -> docId -> { type, title, field, freq }
  private index: Map<string, Map<string, { type: 'initiative' | 'wiki'; title: string; field: string; freq: number }>>;

  // Metadata for filtering
  private docTags: Map<string, string[]>;
  private docStatus: Map<string, string>;
  private docCategory: Map<string, string>;
  private docDate: Map<string, string>;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.initiatives = new InitiativeManager(baseDir);
    this.wiki = new WikiManager(baseDir);
    this.index = new Map();
    this.docTags = new Map();
    this.docStatus = new Map();
    this.docCategory = new Map();
    this.docDate = new Map();
  }

  /**
   * Tokenize text into lowercase terms on whitespace.
   */
  private tokenize(text: string): string[] {
    return text.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  }

  /**
   * Add a document field to the inverted index.
   */
  private indexField(docId: string, type: 'initiative' | 'wiki', title: string, field: string, text: string) {
    const tokens = this.tokenize(text);
    const freqMap = new Map<string, number>();
    for (const token of tokens) {
      freqMap.set(token, (freqMap.get(token) || 0) + 1);
    }

    for (const [term, count] of freqMap) {
      if (!this.index.has(term)) {
        this.index.set(term, new Map());
      }
      const docMap = this.index.get(term)!;
      if (!docMap.has(docId)) {
        docMap.set(docId, { type, title, field, freq: 0 });
      }
      const entry = docMap.get(docId)!;
      entry.freq += count;
    }
  }

  /**
   * Build the inverted index from all initiatives and wiki entries.
   * Scans the file system every time — fast enough for <100 files.
   */
  buildIndex(): void {
    this.index.clear();
    this.docTags.clear();
    this.docStatus.clear();
    this.docCategory.clear();
    this.docDate.clear();

    // Index initiatives
    const initiativesDir = path.join(this.baseDir, 'initiatives');
    if (fs.existsSync(initiativesDir)) {
      const files = fs.readdirSync(initiativesDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
      for (const f of files) {
        try {
          const initiative = this.initiatives.read(f);
          if (!initiative) continue;

          const docId = initiative.id;
          this.indexField(docId, 'initiative', initiative.title, 'title', initiative.title);
          this.indexField(docId, 'initiative', initiative.title, 'objective', initiative.objective);
          this.indexField(docId, 'initiative', initiative.title, 'plan', initiative.plan.map(p => p.description).join(' '));
          this.indexField(docId, 'initiative', initiative.title, 'progressLog', initiative.progressLog.join(' '));

          this.docTags.set(docId, initiative.tags);
          this.docStatus.set(docId, initiative.status);
          this.docDate.set(docId, initiative.created);
        } catch {
          // Skip malformed files
        }
      }
    }

    // Index wiki entries
    const wikiDir = path.join(this.baseDir, 'wiki');
    if (fs.existsSync(wikiDir)) {
      const categories = fs.readdirSync(wikiDir).filter(f => fs.statSync(path.join(wikiDir, f)).isDirectory());
      for (const category of categories) {
        const catDir = path.join(wikiDir, category);
        const files = fs.readdirSync(catDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
        for (const f of files) {
          try {
            const id = f.replace('.md', '');
            const entry = this.wiki.read(category, id);
            if (!entry) continue;

            const docId = `${category}/${id}`;
            this.indexField(docId, 'wiki', entry.title, 'title', entry.title);
            this.indexField(docId, 'wiki', entry.title, 'content', entry.content);

            this.docTags.set(docId, entry.tags);
            this.docCategory.set(docId, category);
          } catch {
            // Skip malformed files
          }
        }
      }
    }
  }

  /**
   * Search the index for documents matching the query.
   * Results are ranked by total term frequency across all query tokens.
   */
  query(query: string, options?: SearchOptions): SearchResult[] {
    // Always rebuild on query to keep results fresh
    this.buildIndex();

    const tokens = this.tokenize(query);
    if (tokens.length === 0) return [];

    // Track matched fields and field-level scores per document
    const scores = new Map<string, { type: 'initiative' | 'wiki'; title: string; score: number; fieldScores: Map<string, number> }>();

    for (const token of tokens) {
      const docMap = this.index.get(token);
      if (!docMap) continue;

      for (const [docId, entry] of docMap) {
        if (!scores.has(docId)) {
          scores.set(docId, { type: entry.type, title: entry.title, score: 0, fieldScores: new Map() });
        }
        const doc = scores.get(docId)!;
        doc.score += entry.freq;
        doc.fieldScores.set(entry.field, (doc.fieldScores.get(entry.field) || 0) + entry.freq);
      }
    }

    const results: SearchResult[] = [];
    for (const [docId, data] of scores) {
      // Apply filters
      if (options?.tags && options.tags.length > 0) {
        const tags = this.docTags.get(docId) || [];
        if (!options.tags.some(t => tags.includes(t))) continue;
      }
      if (options?.status) {
        if (this.docStatus.get(docId) !== options.status) continue;
      }
      if (options?.category) {
        if (this.docCategory.get(docId) !== options.category) continue;
      }
      if (options?.dateFrom) {
        const date = this.docDate.get(docId) || '';
        if (date && date < options.dateFrom) continue;
      }
      if (options?.dateTo) {
        const date = this.docDate.get(docId) || '';
        if (date && date > options.dateTo) continue;
      }

      // Determine best matching field and snippet
      const matchedFields = Array.from(data.fieldScores.keys());
      const bestField = matchedFields.reduce((a, b) => data.fieldScores.get(a)! > data.fieldScores.get(b)! ? a : b, matchedFields[0]);
      const snippet = this.getSnippet(docId, bestField);

      results.push({
        type: data.type,
        id: docId,
        title: data.title,
        score: data.score,
        snippet,
        matchedFields
      });
    }

    // Sort by score descending
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Get a snippet (first 180 chars) from the best-matching field for a document.
   */
  private getSnippet(docId: string, field: string): string {
    // Reconstruct the field content from index entries
    const tokens: string[] = [];
    for (const [term, docMap] of this.index) {
      if (docMap.has(docId) && docMap.get(docId)!.field === field) {
        // This is a matched term - we need the original content for snippet
      }
    }
    // For snippets, read the actual content
    if (docId.includes('/')) {
      // Wiki entry
      const [category, id] = docId.split('/');
      try {
        const entry = this.wiki.read(category, id);
        if (entry) {
          const text = field === 'title' ? entry.title : entry.content;
          return text.replace(/\s+/g, ' ').slice(0, 180);
        }
      } catch { /* fall through */ }
    } else {
      // Initiative
      try {
        const initiative = this.initiatives.findById(docId);
        if (initiative) {
          let text = '';
          if (field === 'title') text = initiative.title;
          else if (field === 'objective') text = initiative.objective;
          else if (field === 'plan') text = initiative.plan.map(p => p.description).join(' ');
          else if (field === 'progressLog') text = initiative.progressLog.join(' ');
          return text.replace(/\s+/g, ' ').slice(0, 180);
        }
      } catch { /* fall through */ }
    }
    return '';
  }
}
