import { SearchResult, SearchOptions } from './types';
/**
 * In-memory inverted index for full-text search across initiatives and wiki.
 * Rebuilds index on demand by scanning the file system.
 */
export declare class SearchEngine {
    private baseDir;
    private initiatives;
    private wiki;
    private index;
    private docTags;
    private docStatus;
    private docCategory;
    private docDate;
    private docType;
    constructor(baseDir: string);
    /**
     * Tokenize text into lowercase terms on whitespace.
     */
    private tokenize;
    /**
     * Add a document field to the inverted index.
     */
    private indexField;
    /**
     * Build the inverted index from all initiatives and wiki entries.
     * Scans the file system every time — fast enough for <100 files.
     */
    buildIndex(): void;
    /**
     * Search the index for documents matching the query.
     * Results are ranked by total term frequency across all query tokens.
     */
    query(query: string, options?: SearchOptions): SearchResult[];
    /**
     * Get a snippet (first 180 chars) from the best-matching field for a document.
     */
    private getSnippet;
}
