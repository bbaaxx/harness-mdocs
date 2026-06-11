#!/usr/bin/env node
import { createMdocsCore } from '../core';
import { status, lookup, resume, dispatch, indexCheck } from '../core/operations';

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

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function ok(value: unknown): CliResult {
  return { exitCode: 0, stdout: json(value), stderr: '' };
}

function fail(message: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: message };
}

function text(value: string): CliResult {
  return { exitCode: 0, stdout: value, stderr: '' };
}

function commandHelp(commandName?: string): string {
  const examples = {
    'initiative.create': [
      'initiative.create',
      '  Payload: { title, id?, owner?, tags?, objective?, plan?, relatedWiki?, phase?, nextAction? }',
      '  Example:',
      '    mdocs command initiative.create --json \'{"id":"add-auth","title":"Add Auth","objective":"Implement login","plan":["Inspect","Implement","Verify"]}\''
    ],
    'initiative.update': [
      'initiative.update',
      '  Payload: { id, updates?, progressNote? }',
      '  Metadata changes may be nested under updates. progressNote stays top-level.',
      '  Example:',
      '    mdocs command initiative.update --json \'{"id":"add-auth","updates":{"phase":"implementation","nextAction":"Run tests"},"progressNote":"Implemented login form"}\''
    ],
    'wiki.create': [
      'wiki.create',
      '  Payload: { category, id, title, content?, tags?, relatedInitiatives?, lifecycle?, knowledgeType?, confidence?, sourceInitiatives?, supersedes?, relatedWiki? }',
      '  Example:',
      '    mdocs command wiki.create --json \'{"category":"testing","id":"cli-help","title":"CLI Help","content":"Payload examples.","relatedInitiatives":["add-auth"]}\''
    ],
    'wiki.update': [
      'wiki.update',
      '  Payload: { category, id, title?, content?, tags?, relatedInitiatives?, lifecycle?, knowledgeType?, confidence?, sourceInitiatives?, supersedes? }',
      '  Changed fields go at the top level after category and id. Do not use an updates wrapper.',
      '  Example:',
      '    mdocs command wiki.update --json \'{"category":"testing","id":"cli-help","content":"Updated learning.","lifecycle":"stable","sourceInitiatives":["add-auth"]}\''
    ]
  };

  if (commandName && commandName in examples) {
    return [
      `Usage: mdocs command ${commandName} --json '<payload-json>'`,
      '',
      ...examples[commandName as keyof typeof examples]
    ].join('\n');
  }

  return [
    'Usage: mdocs command <name> --json \'<payload-json>\'',
    '',
    'Runs an mdocs core command with a JSON payload.',
    '',
    'Payload examples:',
    '',
    ...examples['initiative.create'],
    '',
    ...examples['initiative.update'],
    '',
    ...examples['wiki.create'],
    '',
    ...examples['wiki.update'],
    '',
    'Other commands: initiative.done, initiative.delete, initiative.archive, wiki.stub, wiki.delete, wiki.list, wiki.link, wiki.xref, validate, index.sync'
  ].join('\n');
}

export async function runMdocsCli(args: string[], projectDir = process.cwd()): Promise<CliResult> {
  try {
    // MCP server: stdio is the JSON-RPC channel, so this branch must run
    // before any core construction and must NOT write to stdout.
    if (args[0] === 'mcp') {
      const { startMcpServer } = await import('../surfaces/claude-code/mcp-server');
      await startMcpServer();
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    // Claude Code hook entrypoints. These read stdin and manage their own exit
    // codes (pre-tool-use may exit 2 to block); delegate and report exit 0 here.
    if (args[0] === 'hooks' && args[1] === 'pre-tool-use') {
      const { runPreToolUse } = await import('./hooks/pre-tool-use');
      await runPreToolUse();
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'hooks' && args[1] === 'post-tool-use') {
      const { runPostToolUse } = await import('./hooks/post-tool-use');
      await runPostToolUse();
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    const core = createMdocsCore(projectDir);
    const [command, subcommand] = args;

    if (command === 'init') {
      core.managers.mdocs.init();
      return { exitCode: 0, stdout: JSON.stringify({ success: true }), stderr: '' };
    }

    if (command === 'status') {
      return ok(status(core));
    }

    if (command === 'validate') {
      return ok(core.commands.validationResult());
    }

    if (command === 'lookup' && subcommand) {
      const result = lookup(core, subcommand);
      return result.error ? fail(result.error) : ok(result);
    }

    if (command === 'search' && subcommand) {
      return ok({ results: core.managers.search.query(subcommand) });
    }

    if (command === 'resume') {
      return ok(resume(core, subcommand));
    }

    if (command === 'dispatch') {
      const result = dispatch(core, subcommand);
      return result.error ? fail(result.error) : ok(result);
    }

    if (command === 'index' && (subcommand === 'check' || subcommand === 'repair')) {
      return ok(indexCheck(core, subcommand === 'repair'));
    }

    if (command === 'command' && (subcommand === '--help' || subcommand === 'help' || !subcommand)) {
      return text(commandHelp());
    }

    if (command === 'command' && subcommand && args.includes('--help')) {
      return text(commandHelp(subcommand));
    }

    if (command === 'command' && subcommand) {
      const payload = parseJsonArg(args);
      const result = await core.commands.execute(subcommand, payload);
      return result.error ? { exitCode: 1, stdout: json(result), stderr: '' } : ok(result);
    }

    return fail('Usage: mdocs init | status | validate | resume [initiative-id] | lookup <query> | search <query> | dispatch [initiative-id] | index check | index repair | command <name> --json <args-json>');
  } catch (error: any) {
    return fail(error.message || String(error));
  }
}

if (require.main === module) {
  runMdocsCli(process.argv.slice(2)).then(result => {
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
  });
}
