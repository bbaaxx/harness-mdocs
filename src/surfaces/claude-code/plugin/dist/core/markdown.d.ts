/** Replace a file only after the complete replacement has been written. */
export declare function atomicWrite(filePath: string, content: string): void;
/** Top-level section boundaries, excluding headings inside fenced code. */
export declare function markdownSections(content: string): Array<{
    name: string;
    start: number;
    body: number;
    end: number;
}>;
export declare function readMarkdownSection(content: string, name: string): string;
export declare function readMarkdownList(content: string, name: string): string[];
export declare function writeMarkdownSection(content: string, name: string, value: string, append?: boolean): string;
