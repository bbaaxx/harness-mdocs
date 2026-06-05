import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { MdocsCore } from '../../core';
import { findInitiativeFilename, slugify } from '../../core/commands/utils';

export function createOpencodeTools(core: MdocsCore) {
  const { mdocs, workflow, initiatives, wiki, search, audit, dispatch } = core.managers;

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
          const initiativesDir = path.join(core.mdocsRoot, 'initiatives');
          const allInitiatives = fs.existsSync(initiativesDir)
            ? fs
                .readdirSync(initiativesDir)
                .filter(file => file.endsWith('.md') && file !== 'INDEX.md')
                .map(file => {
                  try {
                    return initiatives.read(file);
                  } catch {
                    return null;
                  }
                })
                .filter((initiative): initiative is NonNullable<typeof initiative> => initiative !== null && initiative !== undefined)
            : [];
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
          const querySlug = slugify(query);
          const initiativesDir = path.join(core.mdocsRoot, 'initiatives');
          const files = fs.existsSync(initiativesDir) ? fs.readdirSync(initiativesDir).filter(file => file.endsWith('.md') && file !== 'INDEX.md') : [];

          for (const fileName of files) {
            const initiative = initiatives.read(fileName);
            if (!initiative) continue;

            const fileStem = fileName.replace(/\.md$/, '');
            const fileSlug = slugify(fileStem.replace(/--\d{4}-\d{2}-\d{2}$/, ''));
            const idSlug = slugify(initiative.id || '');
            const titleSlug = slugify(initiative.title || '');
            const title = initiative.title || '';
            const candidates: Record<string, boolean> = {
              id: initiative.id === query || idSlug === querySlug,
              title: title.toLowerCase().includes(normalizedQuery) || titleSlug === querySlug,
              slug: idSlug === querySlug || titleSlug === querySlug || fileName === query || fileStem === query || fileSlug === querySlug
            };

            const matched = args?.field ? candidates[args.field] : candidates.id || candidates.title || candidates.slug;

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
        const initiativeId = args.initiativeId || workflow.status().activeInitiative;
        if (!initiativeId) return { error: 'No initiativeId provided and no active initiative' };

        const initiative = initiatives.findById(initiativeId);
        if (!initiative) return { error: 'Initiative not found' };

        const wikiEntries: any[] = [];
        for (const wikiRef of initiative.relatedWiki) {
          const [category, id] = wikiRef.split('/');
          if (category && id) {
            const entry = wiki.read(category, id);
            if (entry) wikiEntries.push(entry);
          }
        }

        const searchQuery = `${initiative.title} ${initiative.objective} ${initiative.tags.join(' ')}`;
        const retrievedMemory = search.query(searchQuery).slice(0, 5);
        const recentEvents = audit.query({ initiativeId: initiative.id, limit: 5 });
        const currentStep = workflow.getCurrentStep();
        const context = dispatch.assemble(initiative, wikiEntries, currentStep, { retrievedMemory, recentEvents });

        return {
          context,
          initiativeId: initiative.id,
          step: currentStep,
          relatedWikiCount: wikiEntries.length
        };
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
          const mode = args?.mode || 'check';
          const initiativeResult = initiatives.checkConsistency();
          const wikiResult = wiki.checkConsistency();
          const consistent = initiativeResult.consistent && wikiResult.consistent;

          if (mode === 'repair' && !consistent) {
            initiatives.syncIndex();
            wiki.syncIndices();
            return {
              consistent: true,
              initiatives: { consistent: true, missing: [], orphans: [], stale: false },
              wiki: { consistent: true, missing: [], orphans: [], stale: false },
              repaired: true
            };
          }

          return {
            consistent,
            initiatives: initiativeResult,
            wiki: wikiResult,
            repaired: false
          };
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
            const initiativesDir = path.join(core.mdocsRoot, 'initiatives');
            const allInitiatives = fs.existsSync(initiativesDir)
              ? fs
                  .readdirSync(initiativesDir)
                  .filter(file => file.endsWith('.md') && file !== 'INDEX.md')
                  .map(file => {
                    try {
                      return { init: initiatives.read(file), file };
                    } catch {
                      return null;
                    }
                  })
                  .filter((item): item is NonNullable<typeof item> => item !== null && item.init !== null)
              : [];
            const resumable = allInitiatives
              .filter(({ init }) => init !== null && init.status === 'active')
              .map(({ init }) => {
                const nextAction = init!.nextAction || init!.plan.find(item => item.status !== 'done')?.description || '';
                const daysSinceUpdate = Math.floor((Date.now() - new Date(init!.updated).getTime()) / (1000 * 60 * 60 * 24));
                return {
                  id: init!.id,
                  title: init!.title,
                  nextAction,
                  blockers: init!.blockers || [],
                  lastUpdated: init!.updated,
                  recommendation: daysSinceUpdate > 3 ? 'stale - consider updating progress' : init!.blockers?.length ? 'blocked - resolve blockers first' : 'ready to resume'
                };
              });
            return { resumable, recommendation: resumable.length > 0 ? 'Specify initiativeId to resume one of the above' : 'No active initiatives to resume' };
          }
          const fileName = findInitiativeFilename(core.mdocsRoot, initiatives, initiativeId);
          if (!fileName) return { error: `Initiative not found: ${initiativeId}` };
          const initiative = initiatives.read(fileName);
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
