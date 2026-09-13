import {
  GENERATION_SCHEMA_VERSION,
  GENERATOR_VERSION,
  GenerationDefinition
} from './generator';

const source = (id: string, sourcePath: string) => ({ id, path: `src/generation/fragments/${sourcePath}` });
const output = (outputPath: string, sourceId: string) => ({
  ownershipId: `asset.${outputPath.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '')}`,
  outputPath,
  sourceIds: [sourceId]
});

const outputs = [
  output('.claude/skills/mdocs-initiative/SKILL.md', 'claude.skill.initiative'),
  output('.claude/skills/mdocs-orchestrator/SKILL.md', 'claude.skill.orchestrator'),
  output('.claude/skills/mdocs-workflow/SKILL.md', 'claude.skill.workflow-dogfood'),
  output('agents/mdocs-orchestrator.md', 'opencode.agent.orchestrator'),
  output('prompts/mdocs-initiative.md', 'opencode.prompt.initiative'),
  output('prompts/mdocs-orchestrator.md', 'opencode.prompt.orchestrator'),
  output('prompts/mdocs-workflow.md', 'opencode.prompt.workflow'),
  output('skills/mdocs-initiative/SKILL.md', 'opencode.skill.initiative'),
  output('skills/mdocs-workflow/SKILL.md', 'opencode.skill.workflow'),
  output('src/surfaces/claude-code/assets/agents/mdocs-orchestrator.md', 'claude.agent.orchestrator'),
  output('src/surfaces/claude-code/assets/skills/mdocs-initiative/SKILL.md', 'claude.skill.initiative'),
  output('src/surfaces/claude-code/assets/skills/mdocs-orchestrator/SKILL.md', 'claude.skill.orchestrator'),
  output('src/surfaces/claude-code/assets/skills/mdocs-workflow/SKILL.md', 'claude.skill.workflow'),
  output('src/surfaces/claude-code/assets/templates/claude-md-snippet.md', 'claude.template.memory'),
  output('src/surfaces/claude-code/assets/templates/mcp.json', 'claude.template.mcp'),
  output('src/surfaces/claude-code/assets/templates/settings-patch.json', 'claude.template.settings'),
  output('src/surfaces/claude-code/plugin/agents/mdocs-orchestrator.md', 'claude.agent.orchestrator'),
  output('src/surfaces/claude-code/plugin/skills/mdocs-initiative/SKILL.md', 'claude.skill.initiative'),
  output('src/surfaces/claude-code/plugin/skills/mdocs-orchestrator/SKILL.md', 'claude.skill.orchestrator'),
  output('src/surfaces/claude-code/plugin/skills/mdocs-workflow/SKILL.md', 'claude.skill.workflow'),
  output('src/surfaces/codex/plugin/skills/mdocs-initiative/SKILL.md', 'codex.skill.initiative'),
  output('src/surfaces/codex/plugin/skills/mdocs-orchestrator/SKILL.md', 'codex.skill.orchestrator'),
  output('src/surfaces/codex/plugin/skills/mdocs-workflow/SKILL.md', 'codex.skill.workflow'),
  output('src/surfaces/pi/assets/skills/mdocs-initiative/SKILL.md', 'pi.skill.initiative'),
  output('src/surfaces/pi/assets/skills/mdocs-orchestrator/SKILL.md', 'pi.skill.orchestrator'),
  output('src/surfaces/pi/assets/skills/mdocs-workflow/SKILL.md', 'pi.skill.workflow'),
  output('src/surfaces/pi/assets/templates/pi-agents-md-snippet.md', 'pi.template.memory')
];

export const AGENT_ASSET_GENERATION: GenerationDefinition = {
  schemaVersion: GENERATION_SCHEMA_VERSION,
  generatorVersion: GENERATOR_VERSION,
  manifestPath: 'agents/.mdocs-generation-manifest.json',
  managedRoots: [
    '.claude/skills',
    'agents',
    'prompts',
    'skills',
    'src/surfaces/claude-code/assets/agents',
    'src/surfaces/claude-code/assets/skills',
    'src/surfaces/claude-code/assets/templates',
    'src/surfaces/claude-code/plugin/agents',
    'src/surfaces/claude-code/plugin/skills',
    'src/surfaces/codex/plugin/skills',
    'src/surfaces/pi/assets/skills',
    'src/surfaces/pi/assets/templates'
  ],
  ownership: {
    namespace: 'harness-mdocs.agent-assets',
    outputs: outputs.map(asset => ({ id: asset.ownershipId, paths: [asset.outputPath] }))
  },
  sources: [
    source('claude.agent.orchestrator', 'claude-agent-orchestrator.md'),
    source('claude.skill.initiative', 'claude-skill-initiative.md'),
    source('claude.skill.orchestrator', 'claude-skill-orchestrator.md'),
    source('claude.skill.workflow', 'claude-skill-workflow.md'),
    source('claude.skill.workflow-dogfood', 'claude-skill-workflow-dogfood.md'),
    source('claude.template.mcp', 'claude-template-mcp.json'),
    source('claude.template.memory', 'claude-template-memory.md'),
    source('claude.template.settings', 'claude-template-settings.json'),
    source('codex.skill.initiative', 'codex-skill-initiative.md'),
    source('codex.skill.orchestrator', 'codex-skill-orchestrator.md'),
    source('codex.skill.workflow', 'codex-skill-workflow.md'),
    source('opencode.agent.orchestrator', 'opencode-agent-orchestrator.md'),
    source('opencode.prompt.initiative', 'opencode-prompt-initiative.md'),
    source('opencode.prompt.orchestrator', 'opencode-prompt-orchestrator.md'),
    source('opencode.prompt.workflow', 'opencode-prompt-workflow.md'),
    source('opencode.skill.initiative', 'opencode-skill-initiative.md'),
    source('opencode.skill.workflow', 'opencode-skill-workflow.md'),
    source('pi.skill.initiative', 'pi-skill-initiative.md'),
    source('pi.skill.orchestrator', 'pi-skill-orchestrator.md'),
    source('pi.skill.workflow', 'pi-skill-workflow.md'),
    source('pi.template.memory', 'pi-template-memory.md')
  ],
  outputs
};
