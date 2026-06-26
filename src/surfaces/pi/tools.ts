import { Type } from 'typebox';
import { MdocsCore } from '../../core';
import * as ops from '../../core/operations';
import { toPiToolResult, toPiToolError } from './result';
import type { PiToolResult } from './result';

/**
 * pi custom tool definitions for the mdocs surface.
 *
 * Every tool carries `promptSnippet` (one-line `Available tools` entry) and
 * `promptGuidelines` (bullets appended to the `Guidelines` section) so the
 * model discovers them in the system prompt. Each `execute` wraps a core
 * operation and returns a pi-shaped result via `toPiToolResult`; thrown errors
 * are caught and surfaced via `toPiToolError` so no handler ever throws past
 * the pi boundary.
 *
 * Schemas use TypeBox (`Type.*`). Enum-like string fields use `Type.String`
 * with a description enumerating valid values (broad provider compatibility;
 * avoids an extra `@earendil-works/pi-ai` peer dependency for `StringEnum`).
 */

/**
 * Permissive pi tool definition shape. We keep our own interface (rather
 * than pi's generic `ToolDefinition<TParams, ...>`) so `execute` params stay
 * `any` — TypeBox `Static<any>` widens to `unknown`/`{}` under
 * `ToolDefinition<any, any, any>`, which breaks param access. The extension
 * factory casts each definition to `any` at the `pi.registerTool` boundary
 * (standard for extension interop). `parameters` is a TypeBox schema object
 * used to describe the tool to the LLM.
 */
export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: any) => void) | undefined,
    ctx: any
  ) => Promise<PiToolResult>;
}

/**
 * Run a core operation and wrap the result. Catches all errors so a failing
 * core call never throws past the pi tool boundary (fail open).
 */
async function run(fn: () => unknown): Promise<PiToolResult> {
  try {
    return toPiToolResult(await fn());
  } catch (err) {
    return toPiToolError(err);
  }
}

export function createPiTools(core: MdocsCore): PiToolDefinition[] {
  const { mdocs, search, audit, initiatives, workflow } = core.managers;

  return [
    {
      name: 'mdocs',
      label: 'mdocs',
      description:
        'Run any mdocs core command (initiative.create, initiative.update, initiative.done, initiative.delete, initiative.archive, wiki.create, wiki.update, wiki.ingest, wiki.stub, wiki.delete, wiki.list, wiki.link, wiki.xref, workflow.advance, lifecycle.graduate, validate, index.sync).',
      promptSnippet: 'Run mdocs initiative/wiki commands via command + args',
      promptGuidelines: [
        'Use mdocs (with command + args) as the primary entry point for initiative and wiki mutations; prefer it over editing ./mdocs/ files directly.',
        'Use mdocs with command "initiative.create" to start durable tracking before substantial work, and "initiative.update" with progressNote to record progress.'
      ],
      parameters: Type.Object({
        command: Type.String({ description: 'Command name, e.g. initiative.create, wiki.ingest, validate, index.sync' }),
        args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Command-specific arguments' }))
      }),
      execute: async (_id, params) =>
        run(() => core.commands.execute(params.command, params.args || {}))
    },

    {
      name: 'mdocs_init',
      label: 'mdocs init',
      description: 'Initialize the ./mdocs folder structure (idempotent).',
      promptSnippet: 'Initialize the ./mdocs memory structure',
      promptGuidelines: [
        'Use mdocs_init once when mdocs is not yet initialized in a project before using other mdocs tools.'
      ],
      parameters: Type.Object({}),
      execute: async () =>
        run(() => { mdocs.init(); return { success: true }; })
    },

    {
      name: 'mdocs_status',
      label: 'mdocs status',
      description: 'Show the current workflow state, active initiative, and validation summary.',
      promptSnippet: 'Show current workflow state and active initiative',
      promptGuidelines: [
        'Use mdocs_status at the start of a session and before resuming long-running work to orient on the current workflow step and active initiative.',
        'Use mdocs_status to check validation state before claiming work is complete.'
      ],
      parameters: Type.Object({}),
      execute: async () => run(() => {
        const state = workflow.status();
        const allInitiatives = initiatives.list();
        const activeInitiatives = allInitiatives.filter(i => i.status === 'active');
        const blocked = initiatives.findBlocked();
        const overdue = initiatives.findOverdue();
        const recentAudit = audit.query({ limit: 1 });
        const lastActivity = recentAudit.length > 0 ? recentAudit[0].timestamp : null;

        let resume: any = undefined;
        if (state.activeInitiative) {
          const activeInit = allInitiatives.find(i => i.id === state.activeInitiative);
          if (activeInit) {
            const currentPlanItem = activeInit.plan.find(item => item.status === 'in-progress') || activeInit.plan.find(item => item.status !== 'done');
            const lastUpdated = activeInit.updated;
            const daysSinceUpdate = lastUpdated ? Math.floor((Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24)) : null;
            const staleWarning = daysSinceUpdate !== null && daysSinceUpdate > 3;
            resume = {
              initiative: { id: activeInit.id, title: activeInit.title, status: activeInit.status },
              currentStep: state.currentStep || 'IDLE',
              nextAction: activeInit.nextAction || activeInit.plan.find(item => item.status !== 'done')?.description || '',
              currentPlanItem: currentPlanItem ? { description: currentPlanItem.description, status: currentPlanItem.status } : null,
              blockers: activeInit.blockers || [],
              latestProgress: activeInit.progressLog.at(-1) || '',
              lastUpdated,
              staleWarning
            };
          }
        }

        return {
          workflow: {
            currentStep: state.currentStep || 'IDLE',
            activeInitiative: state.activeInitiative || '',
            stepHistory: state.stepHistory || []
          },
          initiatives: activeInitiatives.map(i => ({
            id: i.id || '',
            title: i.title || '',
            status: i.status || 'active',
            created: i.created || '',
            nextAction: i.nextAction || i.plan.find(item => item.status !== 'done')?.description || '',
            blockers: i.blockers || []
          })),
          blocked: blocked.map(i => ({ id: i.id || '', title: i.title || '', dependsOn: i.dependsOn || [] })),
          overdue: overdue.map(i => ({ id: i.id || '', title: i.title || '', dueDate: i.dueDate || '' })),
          lastActivity,
          resume,
          validation: core.commands.validationResult()
        };
      })
    },

    {
      name: 'mdocs_validate',
      label: 'mdocs validate',
      description: 'Validate mdocs initiative, wiki, and graph-link integrity.',
      promptSnippet: 'Validate initiatives, wiki, and graph links',
      promptGuidelines: [
        'Use mdocs_validate before marking an initiative complete and after structural edits to ./mdocs/ files.'
      ],
      parameters: Type.Object({}),
      execute: async () => run(() => core.commands.validationResult())
    },

    {
      name: 'mdocs_search',
      label: 'mdocs search',
      description: 'Search across initiatives and wiki memory by keyword with optional filters.',
      promptSnippet: 'Search initiatives and wiki memory by keyword',
      promptGuidelines: [
        'Use mdocs_search to find prior initiatives or wiki pages relevant to the current task before starting new work.'
      ],
      parameters: Type.Object({
        query: Type.String({ description: 'Search query' }),
        filters: Type.Optional(
          Type.Object({
            tags: Type.Optional(Type.Array(Type.String())),
            status: Type.Optional(Type.String()),
            category: Type.Optional(Type.String()),
            dateFrom: Type.Optional(Type.String()),
            dateTo: Type.Optional(Type.String())
          })
        )
      }),
      execute: async (_id, params) =>
        run(() => ({ results: search.query(params?.query || '', params?.filters || {}) }))
    },

    {
      name: 'mdocs_lookup',
      label: 'mdocs lookup',
      description: 'Resolve an initiative by id, title, slug, or filename.',
      promptSnippet: 'Resolve an initiative by id, title, slug, or filename',
      promptGuidelines: [
        'Use mdocs_lookup to resolve an initiative id from a partial title or slug before calling mdocs_resume or mdocs_dispatch.'
      ],
      parameters: Type.Object({
        query: Type.String({ description: 'Initiative id, title, slug, or filename to resolve' }),
        field: Type.Optional(Type.String({ description: 'Optional field to constrain lookup: id | title | slug' }))
      }),
      execute: async (_id, params) => {
        const query = params?.query || '';
        if (params?.field) {
          return run(() => {
            const match = initiatives.list(true).map(initiative => ({
              initiative,
              key: initiatives.findKeyById(initiative.id) || initiative.id
            })).find(({ initiative, key }) => {
              const keyStem = key.replace(/\.md$/, '');
              const keySlug = slugifyLocal(keyStem.replace(/--\d{4}-\d{2}-\d{2}$/, ''));
              const idSlug = slugifyLocal(initiative.id || '');
              const titleSlug = slugifyLocal(initiative.title || '');
              const querySlug = slugifyLocal(query);
              const candidates: Record<string, boolean> = {
                id: initiative.id === query || idSlug === querySlug,
                title: initiative.title.toLowerCase().includes(query.toLowerCase()) || titleSlug === querySlug,
                slug: idSlug === querySlug || titleSlug === querySlug || key === query || keyStem === query || keySlug === querySlug
              };
              return candidates[params.field!];
            });
            if (match) return {
              type: 'initiative',
              id: match.initiative.id,
              title: match.initiative.title,
              status: match.initiative.status,
              tags: match.initiative.tags,
              filename: match.key
            };
            return { error: 'No initiatives found for query', query };
          });
        }
        return run(() => ops.lookup(core, query));
      }
    },

    {
      name: 'mdocs_dispatch',
      label: 'mdocs dispatch',
      description:
        'Assemble subagent context from an initiative and its related wiki entries. pi has no native subagent, so the returned context bundle is carried forward manually (e.g. pasted into a new session or handed to a skill).',
      promptSnippet: 'Assemble subagent handoff context for an initiative',
      promptGuidelines: [
        'Use mdocs_dispatch to assemble a handoff context bundle before delegating work to another session or agent; pass the returned context into the follow-up prompt.'
      ],
      parameters: Type.Object({
        initiativeId: Type.Optional(Type.String({ description: 'Initiative id to assemble context for; defaults to the active initiative' }))
      }),
      execute: async (_id, params) => run(() => ops.dispatch(core, params?.initiativeId))
    },

    {
      name: 'mdocs_ingest',
      label: 'mdocs ingest',
      description:
        'Batch-compose wiki pages + compiled views (overview.md/log.md) from caller-supplied operations. Records only caller-supplied ops — never auto-generates prose.',
      promptSnippet: 'Batch-compose wiki pages + overview/log from caller ops',
      promptGuidelines: [
        'Use mdocs_ingest to batch-create or update wiki pages and overview/log sections; author all text yourself — ingest only records what you give it.'
      ],
      parameters: Type.Object({
        operations: Type.Array(Type.Record(Type.String(), Type.Any()), { description: 'Caller-authored operations: createPage, updatePage, updateOverviewSection, appendLog, link' }),
        note: Type.Optional(Type.String({ description: 'Optional note echoed in the manifest' }))
      }),
      execute: async (_id, params) =>
        run(() => core.commands.execute('wiki.ingest', { operations: params?.operations || [], note: params?.note }))
    },

    {
      name: 'mdocs_audit',
      label: 'mdocs audit',
      description: 'Query the audit log for tool, workflow, initiative, and wiki events.',
      promptSnippet: 'Query the mdocs audit log',
      promptGuidelines: [
        'Use mdocs_audit to review recent tool activity or the history of an initiative.'
      ],
      parameters: Type.Object({
        initiativeId: Type.Optional(Type.String()),
        type: Type.Optional(Type.String({ description: 'Event type: tool | workflow | initiative | wiki' })),
        limit: Type.Optional(Type.Number()),
        startDate: Type.Optional(Type.String()),
        endDate: Type.Optional(Type.String())
      }),
      execute: async (_id, params) =>
        run(() => ({ events: audit.query({
          initiativeId: params?.initiativeId,
          type: params?.type,
          limit: params?.limit,
          startDate: params?.startDate,
          endDate: params?.endDate
        }) }))
    },

    {
      name: 'mdocs_index_check',
      label: 'mdocs index check',
      description: 'Check (or repair) INDEX consistency for initiatives and wiki.',
      promptSnippet: 'Check or repair mdocs index consistency',
      promptGuidelines: [
        'Use mdocs_index_check after manual edits to ./mdocs/ files; use mode "repair" to regenerate indices when inconsistencies are reported.'
      ],
      parameters: Type.Object({
        mode: Type.Optional(Type.String({ description: "Mode: 'check' (default) reports inconsistencies, 'repair' regenerates indices" }))
      }),
      execute: async (_id, params) =>
        run(() => ops.indexCheck(core, (params?.mode || 'check') === 'repair'))
    },

    {
      name: 'mdocs_resume',
      label: 'mdocs resume',
      description:
        'Resume the active or specified initiative with next action and validation. Auto-starts a fresh cycle (lands at UNDERSTAND) when the prior initiative reached COMPLETE or at IDLE.',
      promptSnippet: 'Resume an active or specified initiative',
      promptGuidelines: [
        'Use mdocs_resume to pick up existing work at the start of a session; without an initiativeId it lists resumable active initiatives.'
      ],
      parameters: Type.Object({
        initiativeId: Type.Optional(Type.String({ description: 'Initiative id to resume; defaults to the active initiative' }))
      }),
      execute: async (_id, params) => {
        const initiativeId = params?.initiativeId || workflow.status().activeInitiative;
        if (!initiativeId) {
          return run(() => {
            const resumable = initiatives.list()
              .filter(init => init.status === 'active')
              .map(init => {
                const nextAction = init.nextAction || init.plan.find(item => item.status !== 'done')?.description || '';
                const daysSinceUpdate = Math.floor((Date.now() - new Date(init.updated).getTime()) / (1000 * 60 * 60 * 24));
                return {
                  id: init.id,
                  title: init.title,
                  nextAction,
                  blockers: init.blockers || [],
                  lastUpdated: init.updated,
                  recommendation: daysSinceUpdate > 3 ? 'stale - consider updating progress' : init.blockers?.length ? 'blocked - resolve blockers first' : 'ready to resume'
                };
              });
            return {
              resumable,
              recommendation: resumable.length > 0 ? 'Specify initiativeId to resume one of the above' : 'No active initiatives to resume'
            };
          });
        }
        return run(() => ops.resume(core, initiativeId));
      }
    },

    {
      name: 'mdocs_advance',
      label: 'mdocs advance',
      description:
        'Advance the workflow to the next step (UNDERSTAND, DISCOVER, CONTEXT, PLAN, EXECUTE, VERIFY, REPORT, COMPLETE). Drives the gates that block write/edit before PLAN.',
      promptSnippet: 'Advance the mdocs workflow to the next step',
      promptGuidelines: [
        'Use mdocs_advance to drive the workflow forward; steps must be reached in order (no skipping, no going back).',
        'Use mdocs_advance with step "PLAN" to unblock write/edit on project source; edits under ./mdocs/ are always allowed.'
      ],
      parameters: Type.Object({
        step: Type.String({ description: 'Next workflow step, e.g. UNDERSTAND, PLAN, EXECUTE, COMPLETE' })
      }),
      execute: async (_id, params) =>
        run(() => core.commands.execute('workflow.advance', { step: params?.step }))
    },

    {
      name: 'mdocs_reset',
      label: 'mdocs reset',
      description:
        'Reset the workflow to IDLE and clear the active initiative (full clean slate). Use to abandon an initiative mid-flight, force-reset for testing, or begin a fresh initiative cycle after COMPLETE.',
      promptSnippet: 'Reset the workflow to IDLE and clear active initiative',
      promptGuidelines: [
        'Use mdocs_reset to abandon an initiative mid-flight or to begin a fresh initiative cycle after COMPLETE; it clears the active initiative.'
      ],
      parameters: Type.Object({}),
      execute: async () => run(() => ops.reset(core))
    }
  ];
}

function slugifyLocal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Names of every tool registered by the pi surface, in registration order. */
export const PI_TOOL_NAMES = [
  'mdocs', 'mdocs_init', 'mdocs_status', 'mdocs_validate', 'mdocs_search',
  'mdocs_lookup', 'mdocs_dispatch', 'mdocs_ingest', 'mdocs_audit',
  'mdocs_index_check', 'mdocs_resume', 'mdocs_advance', 'mdocs_reset'
] as const;
