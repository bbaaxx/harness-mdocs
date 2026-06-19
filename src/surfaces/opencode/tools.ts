import { z } from 'zod';
import { MdocsCore } from '../../core';
import { dispatch as dispatchOperation, indexCheck as indexCheckOperation } from '../../core/operations';

export function createOpencodeTools(core: MdocsCore) {
  const { mdocs, workflow, initiatives, search, audit } = core.managers;

  return {
    mdocs: {
      description: 'Run mdocs initiative/wiki commands',
      args: {
        command: z.string().describe('Command name, e.g. initiative.create, initiative.update, validate, index.sync'),
        args: z.record(z.string(), z.any()).optional().describe('Command-specific arguments')
      },
      execute: async (input: { command: string; args?: Record<string, any> }) => core.commands.execute(input.command, input.args || {})
    },
    mdocs_init: {
      description: 'Initialize /mdocs folder structure',
      args: {},
      execute: async () => {
        try {
          mdocs.init();
          return { success: true };
        } catch (err: any) {
          return { error: err.message || String(err) };
        }
      }
    },
    mdocs_status: {
      description: 'Show current workflow state and active initiatives',
      args: {},
      execute: async () => {
        try {
          const state = workflow.status();
          const allInitiatives = initiatives.list();
          const activeInitiatives = allInitiatives.filter(initiative => initiative.status === 'active');
          const blocked = initiatives.findBlocked();
          const overdue = initiatives.findOverdue();
          const recentAudit = audit.query({ limit: 1 });
          const lastActivity = recentAudit.length > 0 ? recentAudit[0].timestamp : null;

          let resume: any = undefined;
          if (state.activeInitiative) {
            const activeInit = allInitiatives.find(initiative => initiative.id === state.activeInitiative);
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
            initiatives: activeInitiatives.map(initiative => ({
              id: initiative.id || '',
              title: initiative.title || '',
              status: initiative.status || 'active',
              created: initiative.created || '',
              nextAction: initiative.nextAction || initiative.plan.find(item => item.status !== 'done')?.description || '',
              blockers: initiative.blockers || []
            })),
            blocked: blocked.map(initiative => ({
              id: initiative.id || '',
              title: initiative.title || '',
              dependsOn: initiative.dependsOn || []
            })),
            overdue: overdue.map(initiative => ({
              id: initiative.id || '',
              title: initiative.title || '',
              dueDate: initiative.dueDate || ''
            })),
            lastActivity,
            resume,
            validation: core.commands.validationResult()
          };
        } catch (err: any) {
          return {
            error: err.message || String(err),
            workflow: { currentStep: 'IDLE', activeInitiative: '', stepHistory: [] },
            initiatives: [],
            blocked: [],
            overdue: []
          };
        }
      }
    },
    mdocs_validate: {
      description: 'Validate mdocs initiative and wiki integrity',
      args: {},
      execute: async () => {
        try {
          return core.commands.validationResult();
        } catch (err: any) {
          return { error: err.message || String(err) };
        }
      }
    },
    mdocs_search: {
      description: 'Search across initiatives and wiki by keyword',
      args: {
        query: z.string().describe('Search query'),
        filters: z
          .object({
            tags: z.array(z.string()).optional(),
            status: z.string().optional(),
            category: z.string().optional(),
            dateFrom: z.string().optional(),
            dateTo: z.string().optional()
          })
          .optional()
          .describe('Optional search filters')
      },
      execute: async (args: { query: string; filters?: { tags?: string[]; status?: string; category?: string; dateFrom?: string; dateTo?: string } }) => {
        try {
          const results = search.query(args?.query || '', args?.filters || {});
          return {
            results: results.map(result => ({
              type: result.type || '',
              id: result.id || '',
              title: result.title || '',
              score: result.score || 0
            }))
          };
        } catch (err: any) {
          return { error: err.message || String(err), results: [] };
        }
      }
    },
    mdocs_lookup: {
      description: 'Resolve an initiative by id, title, slug, or filename',
      args: {
        query: z.string().describe('Initiative id, title, slug, or filename to resolve'),
        field: z.enum(['id', 'title', 'slug']).optional().describe('Optional field to constrain lookup')
      },
      execute: async (args: { query: string; field?: 'id' | 'title' | 'slug' }) => {
        try {
          const query = args?.query || '';
          const normalizedQuery = query.toLowerCase();
          const match = args?.field
            ? initiatives.list(true).map(initiative => ({ initiative, key: initiatives.findKeyById(initiative.id) || initiative.id })).find(({ initiative, key }) => {
                const keyStem = key.replace(/\.md$/, '');
                const keySlug = slugifyLocal(keyStem.replace(/--\d{4}-\d{2}-\d{2}$/, ''));
                const idSlug = slugifyLocal(initiative.id || '');
                const titleSlug = slugifyLocal(initiative.title || '');
                const querySlug = slugifyLocal(query);
                const candidates: Record<string, boolean> = {
                  id: initiative.id === query || idSlug === querySlug,
                  title: initiative.title.toLowerCase().includes(normalizedQuery) || titleSlug === querySlug,
                  slug: idSlug === querySlug || titleSlug === querySlug || key === query || keyStem === query || keySlug === querySlug
                };
                return candidates[args.field!];
              })
            : initiatives.findByQuery(query);

          if (match) return {
            type: 'initiative',
            id: match.initiative.id,
            title: match.initiative.title,
            status: match.initiative.status,
            tags: match.initiative.tags,
            filename: match.key
          };

          return { error: 'No initiatives found for query', query };
        } catch (err: any) {
          return { error: err.message || String(err) };
        }
      }
    },
    mdocs_dispatch: {
      description: 'Assemble subagent context from an initiative and its related wiki entries',
      args: {
        initiativeId: z.string().optional().describe('Initiative id to assemble context for; defaults to active initiative')
      },
      execute: async (args: { initiativeId?: string }) => {
        return dispatchOperation(core, args.initiativeId);
      }
    },
    mdocs_audit: {
      description: 'Query the audit log for events',
      args: {
        initiativeId: z.string().optional().describe('Optional initiative id to filter audit events'),
        limit: z.number().optional().describe('Maximum number of audit events to return')
      },
      execute: async (args: { initiativeId?: string; limit?: number }) => {
        const events = audit.query({
          initiativeId: args.initiativeId,
          limit: args.limit
        });
        return { events };
      }
    },
    mdocs_index_check: {
      description: 'Check and repair INDEX consistency for initiatives and wiki',
      args: {
        mode: z.enum(['check', 'repair']).optional().describe("Mode: 'check' reports inconsistencies, 'repair' regenerates indices")
      },
      execute: async (args: { mode?: 'check' | 'repair' }) => {
        try {
          return indexCheckOperation(core, (args?.mode || 'check') === 'repair');
        } catch (err: any) {
          return { error: err.message || String(err) };
        }
      }
    },
    mdocs_resume: {
      description: 'Resume active or specified initiative with next action and validation',
      args: {
        initiativeId: z.string().optional().describe('Initiative id to resume; defaults to active initiative')
      },
      execute: async (args: { initiativeId?: string }) => {
        try {
          const initiativeId = args?.initiativeId || workflow.status().activeInitiative;
          if (!initiativeId) {
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
            return { resumable, recommendation: resumable.length > 0 ? 'Specify initiativeId to resume one of the above' : 'No active initiatives to resume' };
          }
          const initiative = initiatives.findById(initiativeId);
          if (!initiative) return { error: `Initiative not found: ${initiativeId}` };
          workflow.setActiveInitiative(initiative.id);
          return {
            initiative: { id: initiative.id, title: initiative.title, status: initiative.status },
            currentStep: workflow.status().currentStep,
            nextAction: initiative.nextAction || initiative.plan.find(item => item.status !== 'done')?.description || '',
            blockers: initiative.blockers || [],
            latestProgress: initiative.progressLog.at(-1) || '',
            validation: core.commands.validationResult()
          };
        } catch (err: any) {
          return { error: err.message || String(err) };
        }
      }
    }
  };
}

function slugifyLocal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
