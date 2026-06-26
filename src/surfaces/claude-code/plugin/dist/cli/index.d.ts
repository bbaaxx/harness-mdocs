#!/usr/bin/env node
export interface CliResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
export declare function runMdocsCli(args: string[], projectDir?: string): Promise<CliResult>;
