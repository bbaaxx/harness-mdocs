import { EnforcementMode, IdleStrictness } from './workflow/engine';
export type InitiativeMode = 'flat' | 'directory' | 'auto';
export type WikiIndexMode = 'generated-uppercase' | 'canonical-lowercase' | 'none' | 'auto';
export type ArchiveDirMode = 'archive' | '_archive' | 'auto';
export type IndexOwner = 'harness' | 'external' | 'none';
export interface MdocsCompatibilityConfig {
    initiativeMode?: InitiativeMode;
    wikiIndexMode?: WikiIndexMode;
    /**
     * Optional override for who owns the wiki index. For directory-v2
     * (canonical-lowercase), the safe default is `'external'` (no-op on
     * sync). Set `wikiIndexOwner: 'harness'` to opt into harness maintaining
     * the lowercase `wiki/index.md`. Ignored where inapplicable.
     */
    wikiIndexOwner?: IndexOwner;
    archiveDir?: ArchiveDirMode;
    legacyFlatFiles?: boolean | 'auto';
    obsidianRefreshCommand?: string | string[] | null;
    /**
     * Workflow enforcement mode. `gate` (default) blocks Write/Edit before
     * PLAN; `advisory` allows writes but still audits; `off` disables
     * enforcement entirely (CI escape hatch). Precedence: env > file > default.
     */
    enforcementMode?: EnforcementMode;
    /**
     * IDLE strictness. `open` (default) allows every tool at IDLE (0.4.2
     * behaviour); `readonly` blocks Write/Edit/Bash at IDLE until the workflow
     * advances. Precedence: env > file > default.
     */
    idle?: IdleStrictness;
    /**
     * How initiative `_status.md` files are written. `full` (default) keeps the
     * harness-authored Objective/Plan/Progress Log body and full frontmatter.
     * `metadata-only` treats the file as thin lifecycle metadata: surgical
     * lifecycle-key updates only, no body-section injection, and no new
     * frontmatter keys — for consumer trees that keep artifacts in sibling
     * files. Opt-in via `.mdocs.json`; defaults to current (`full`) behavior.
     */
    initiativeRecordMode?: 'full' | 'metadata-only';
}
export interface MdocsContract {
    initiativeMode: Exclude<InitiativeMode, 'auto'>;
    wikiIndexMode: Exclude<WikiIndexMode, 'auto'>;
    archiveDir: Exclude<ArchiveDirMode, 'auto'>;
    legacyFlatFiles: boolean;
    wikiIndexOwner: IndexOwner;
    obsidianVisibilityLayer: boolean;
    obsidianDir?: string;
    obsidianRefreshCommand?: string | string[] | null;
    enforcementMode: EnforcementMode;
    idle: IdleStrictness;
    initiativeRecordMode: 'full' | 'metadata-only';
}
export declare function detectMdocsContract(mdocsRoot: string, config?: MdocsCompatibilityConfig): MdocsContract;
