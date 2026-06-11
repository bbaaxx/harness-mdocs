import * as fs from 'fs';
import * as path from 'path';

/**
 * Asset resolution for the Claude Code surface.
 *
 * Assets (SKILL.md files, templates, agent prompt) ship at
 *   <pkg>/src/surfaces/claude-code/assets/
 * and are NOT compiled. From the compiled module at
 *   <pkg>/dist/surfaces/claude-code/skills.js
 * the assets dir is three levels up plus the src path.
 */
export function assetsDir(): string {
  return path.resolve(__dirname, '../../../src/surfaces/claude-code/assets');
}

export const SKILL_NAMES = ['mdocs-workflow', 'mdocs-initiative', 'mdocs-orchestrator'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/** Absolute path to a skill's SKILL.md. */
export function skillPath(name: SkillName): string {
  return path.join(assetsDir(), 'skills', name, 'SKILL.md');
}

/** List the skill names that have a SKILL.md present on disk. */
export function listSkills(): SkillName[] {
  return SKILL_NAMES.filter(name => fs.existsSync(skillPath(name)));
}

/** Read a skill's SKILL.md content. Returns null if missing. */
export function readSkill(name: SkillName): string | null {
  const p = skillPath(name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/** Absolute path to the templates directory. */
export function templatesDir(): string {
  return path.join(assetsDir(), 'templates');
}

/** List template filenames present on disk. */
export function listTemplates(): string[] {
  const dir = templatesDir();
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** Read a template file by name (e.g. 'claude-md-snippet.md'). Returns null if missing. */
export function readTemplate(name: string): string | null {
  const p = path.join(templatesDir(), name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
