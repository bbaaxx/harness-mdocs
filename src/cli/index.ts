#!/usr/bin/env node
import { createMdocsCore } from '../core';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function parseJsonArg(args: string[]) {
  const index = args.indexOf('--json');
  if (index === -1) return {};
  const value = args[index + 1];
  if (!value) throw new Error('--json requires a JSON object string');
  return JSON.parse(value);
}

export async function runMdocsCli(args: string[], projectDir = process.cwd()): Promise<CliResult> {
  try {
    const core = createMdocsCore(projectDir);
    const [command, subcommand] = args;

    if (command === 'init') {
      core.managers.mdocs.init();
      return { exitCode: 0, stdout: JSON.stringify({ success: true }), stderr: '' };
    }

    if (command === 'status') {
      return { exitCode: 0, stdout: JSON.stringify(core.managers.workflow.status(), null, 2), stderr: '' };
    }

    if (command === 'validate') {
      return { exitCode: 0, stdout: JSON.stringify(core.commands.validationResult(), null, 2), stderr: '' };
    }

    if (command === 'command' && subcommand) {
      const payload = parseJsonArg(args);
      const result = await core.commands.execute(subcommand, payload);
      return { exitCode: result.error ? 1 : 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Usage: mdocs init | status | validate | command <name> --json <args-json>'
    };
  } catch (error: any) {
    return { exitCode: 1, stdout: '', stderr: error.message || String(error) };
  }
}

if (require.main === module) {
  runMdocsCli(process.argv.slice(2)).then(result => {
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
  });
}
