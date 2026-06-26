import { LintResult } from '../types';
export interface MdocsLinterOptions {
    /**
     * Mirrors `MdocsContract.initiativeRecordMode`. `metadata-only` relaxes
     * initiative body-section and required-field checks for consumer trees that
     * keep artifacts in sibling files; `full` (default) is current behavior.
     */
    initiativeRecordMode?: 'full' | 'metadata-only';
}
export declare class MdocsLinter {
    private baseDir;
    protected readonly initiativeRecordMode: 'full' | 'metadata-only';
    constructor(baseDir: string, options?: MdocsLinterOptions);
    lintFile(filePath: string): LintResult;
    lintAll(): LintResult[];
    private lintGraph;
    private listInitiativeFiles;
    private rootWikiFiles;
    private lintInitiative;
    /**
     * Whole-day age between `dateStr` and today. Returns null when the value is
     * missing or unparseable. Lifecycle lint rules use this to compute staleness.
     */
    private daysSince;
    private lintWiki;
}
