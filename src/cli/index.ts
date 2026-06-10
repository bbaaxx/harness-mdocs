#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { createMdocsCore } from '../core';
import { findInitiativeFilename, slugify } from '../core/commands/utils';

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
    const core = createMdocsCore(projectDir);
    const [command, subcommand] = args;

    if (command === 'init') {
      core.managers.mdocs.init();
      return { exitCode: 0, stdout: JSON.stringify({ success: true }), stderr: '' };
    }

    if (command === 'status') {
      return ok(workflowStatus(core));
    }

    if (command === 'validate') {
      return ok(core.commands.validationResult());
    }

    if (command === 'lookup' && subcommand) {
      const result = lookupInitiative(core, subcommand);
      return result.error ? fail(result.error) : ok(result);
    }

    if (command === 'search' && subcommand) {
      return ok({ results: core.managers.search.query(subcommand) });
    }

    if (command === 'resume') {
      return ok(resumeInitiative(core, subcommand));
    }

    if (command === 'dispatch') {
      const result = dispatchContext(core, subcommand);
      return result.error ? fail(result.error) : ok(result);
    }

    if (command === 'index' && (subcommand === 'check' || subcommand === 'repair')) {
      const initiativeResult = core.managers.initiatives.checkConsistency();
      const wikiResult = core.managers.wiki.checkConsistency();
      const consistent = initiativeResult.consistent && wikiResult.consistent;

      if (subcommand === 'repair') {
        if (!consistent) {
          core.managers.initiatives.syncIndex();
          core.managers.wiki.syncIndices();
        }
        return ok({
          consistent: true,
          initiatives: consistent ? initiativeResult : core.managers.initiatives.checkConsistency(),
          wiki: consistent ? wikiResult : core.managers.wiki.checkConsistency(),
          repaired: !consistent
        });
      }

      return ok({ consistent, initiatives: initiativeResult, wiki: wikiResult, repaired: false });
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

function lookupInitiative(core: ReturnType<typeof createMdocsCore>, query: string) {
  const normalizedQuery = query.toLowerCase();
  const querySlug = slugify(query);
  const initiativesDir = path.join(core.mdocsRoot, 'initiatives');
  const files = fs.existsSync(initiativesDir) ? fs.readdirSync(initiativesDir).filter(file => file.endsWith('.md') && file !== 'INDEX.md') : [];

  for (const fileName of files) {
    const initiative = core.managers.initiatives.read(fileName);
    if (!initiative) continue;

    const fileStem = fileName.replace(/\.md$/, '');
    const fileSlug = slugify(fileStem.replace(/--\d{4}-\d{2}-\d{2}$/, ''));
    const idSlug = slugify(initiative.id || '');
    const titleSlug = slugify(initiative.title || '');
    const title = initiative.title || '';
    const matched =
      initiative.id === query ||
      idSlug === querySlug ||
      title.toLowerCase().includes(normalizedQuery) ||
      titleSlug === querySlug ||
      fileName === query ||
      fileStem === query ||
      fileSlug === querySlug;

    if (matched) {
      return {
        type: 'initiative',
        id: initiative.id,
        title: initiative.title,
        status: initiative.status,
        tags: initiative.tags,
        filename: fileName
      };
    }
  }

  return { error: `No initiatives found for query: ${query}` };
}

function resumeInitiative(core: ReturnType<typeof createMdocsCore>, initiativeId?: string) {
  const id = initiativeId || workflowStatus(core).activeInitiative;
  if (!id) {
    return { resumable: core.managers.search.query('', { status: 'active' }).filter(result => result.type === 'initiative') };
  }

  const fileName = findInitiativeFilename(core.mdocsRoot, core.managers.initiatives, id);
  if (!fileName) return { error: `Initiative not found: ${id}` };
  const initiative = core.managers.initiatives.read(fileName);
  if (!initiative) return { error: `Initiative not found: ${id}` };
  core.managers.workflow.setActiveInitiative(initiative.id);
  return {
    initiative: { id: initiative.id, title: initiative.title, status: initiative.status },
    currentStep: core.managers.workflow.status().currentStep,
    nextAction: initiative.nextAction || initiative.plan.find(item => item.status !== 'done')?.description || '',
    blockers: initiative.blockers || [],
    latestProgress: initiative.progressLog.at(-1) || '',
    validation: core.commands.validationResult()
  };
}

function dispatchContext(core: ReturnType<typeof createMdocsCore>, initiativeId?: string) {
  const id = initiativeId || workflowStatus(core).activeInitiative;
  if (!id) return { error: 'No initiativeId provided and no active initiative' };

  const initiative = core.managers.initiatives.findById(id);
  if (!initiative) return { error: 'Initiative not found' };

  const wikiEntries = [];
  for (const wikiRef of initiative.relatedWiki) {
    const [category, entryId] = wikiRef.split('/');
    if (category && entryId) {
      const entry = core.managers.wiki.read(category, entryId);
      if (entry) wikiEntries.push(entry);
    }
  }

  const retrievedMemory = core.managers.search.query(`${initiative.title} ${initiative.objective} ${initiative.tags.join(' ')}`).slice(0, 5);
  const recentEvents = core.managers.audit.query({ initiativeId: initiative.id, limit: 5 });
  const currentStep = core.managers.workflow.getCurrentStep();
  const context = core.managers.dispatch.assemble(initiative, wikiEntries, currentStep, { retrievedMemory, recentEvents });

  return {
    context,
    initiativeId: initiative.id,
    step: currentStep,
    relatedWikiCount: wikiEntries.length
  };
}

function workflowStatus(core: ReturnType<typeof createMdocsCore>) {
  const state = core.managers.workflow.status();
  if (!state.activeInitiative) return state;

  const fileName = findInitiativeFilename(core.mdocsRoot, core.managers.initiatives, state.activeInitiative);
  const initiative = fileName ? core.managers.initiatives.read(fileName) : null;
  if (initiative?.status === 'active') return state;

  core.managers.workflow.setActiveInitiative(null);
  return core.managers.workflow.status();
}

if (require.main === module) {
  runMdocsCli(process.argv.slice(2)).then(result => {
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
  });
}
