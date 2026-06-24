import { MdocsCompatibilityConfig } from '../contract';
import { type WikiEntry } from '../types';
export interface WikiManagerOptions {
    standaloneCategories?: string[];
    compatibility?: MdocsCompatibilityConfig;
}
export declare class WikiManager {
    private dir;
    private standaloneCategories;
    private contract;
    constructor(baseDir: string, options?: WikiManagerOptions);
    private toFrontmatter;
    private sanitizeName;
    private isRootCategory;
    private assertRootWritable;
    private generateReferencedBySection;
    private stripReferencedBySection;
    private referencedByMarker;
    create(entry: WikiEntry): string;
    read(category: string, id: string): WikiEntry | null;
    readByRef(ref: string): WikiEntry | null;
    refFor(entry: WikiEntry): string;
    private readRoot;
    private parseWikiEntry;
    private parseRelatedWiki;
    private referencedWikiRefs;
    update(category: string, id: string, entry: WikiEntry): string;
    addRelatedInitiative(category: string, id: string, initiativeId: string): string;
    addRelatedInitiativeByRef(ref: string, initiativeId: string): string;
    getReferencedBy(category: string, id: string): string[];
    private extractWikiRefs;
    addWikiCrossRef(fromCategory: string, fromId: string, toCategory: string, toId: string): string;
    delete(category: string, id: string): void;
    list(category?: string): WikiEntry[];
    syncIndices(): string[];
    findRelated(queryTags: string[]): WikiEntry[];
    stub(category: string, id: string, title?: string, template?: string): {
        success: boolean;
        existing?: boolean;
        filePath: string;
    };
    private defaultStubTemplate;
    private entityOrGenericStubTemplate;
    private defaultRepoTemplate;
    private defaultSystemTemplate;
    validate(): {
        valid: boolean;
        errors: string[];
        warnings: string[];
    };
    private rootWikiFiles;
    private categoryDirs;
    private listInitiativeFiles;
    checkConsistency(): {
        consistent: boolean;
        missing: string[];
        orphans: string[];
        stale: boolean;
    };
    private writeIndexMeta;
    private updateIndices;
    /**
     * Build the lowercase canonical `wiki/index.md` content. Format matches the
     * grouped/status-tagged style already in use: `# Wiki` header, a stable
     * descriptive sentence, then one `- [Title](relative-path.md)` line per wiki
     * entry (root and category) sorted by relative path so output is byte-stable
     * across runs given the same on-disk set.
     */
    private generateLowercaseCanonicalIndex;
    private writeLowercaseCanonicalIndex;
    /**
     * Serialize the minimal root-file frontmatter shape used by the harness-owned
     * compiled views (overview.md, log.md). Mirrors the JSON-serialized style of
     * `toFrontmatter` (key: <JSON>) so the files pass `validate()` root-file
     * checks and parse cleanly via `readRoot`.
     */
    private serializeCompiledViewFrontmatter;
    /**
     * Idempotently set one named H2 section of wiki/overview.md. Creates the file
     * (frontmatter + '# Overview') if absent. If the section exists, replaces its
     * body in place preserving all other sections byte-for-byte; if absent, appends
     * a new section at the end. Bumps the frontmatter `updated` date.
     * No-op (returns null) outside directory-v2 (canonical-lowercase) mode.
     * Never writes wiki/index.md directly.
     */
    updateOverviewSection(section: string, body: string): string | null;
    /**
     * Append one timestamped block to wiki/log.md. Creates the file (frontmatter +
     * '# Log') if absent. The timestamp defaults to new Date().toISOString(); the
     * content is caller-supplied (entry.content, or entry if a string is passed).
     * Existing entries are preserved and never reordered.
     *
     * Consumer-format heading: when BOTH entry.operation and entry.subject are
     * supplied, the block heading is `## [YYYY-MM-DD] {operation} | {subject}`
     * where the date is entry.date (YYYY-MM-DD) or today. The legacy
     * `## {timestamp}` form is preserved byte-for-byte for every other caller.
     *
     * No-op (returns null) outside directory-v2 (canonical-lowercase) mode.
     * Never writes wiki/index.md directly.
     */
    appendLog(entry: {
        timestamp?: string;
        date?: string;
        operation?: string;
        subject?: string;
        content: string;
    } | string): string | null;
}
