/**
 * Asset resolution for the Claude Code surface.
 *
 * Assets (SKILL.md files, templates, agent prompt) ship at
 *   <pkg>/src/surfaces/claude-code/assets/
 * and are NOT compiled. From the compiled module at
 *   <pkg>/dist/surfaces/claude-code/skills.js
 * the assets dir is three levels up plus the src path.
 */
export declare function assetsDir(): string;
export declare const SKILL_NAMES: readonly ["mdocs-workflow", "mdocs-initiative", "mdocs-orchestrator"];
export type SkillName = (typeof SKILL_NAMES)[number];
/** Absolute path to a skill's SKILL.md. */
export declare function skillPath(name: SkillName): string;
/** List the skill names that have a SKILL.md present on disk. */
export declare function listSkills(): SkillName[];
/** Read a skill's SKILL.md content. Returns null if missing. */
export declare function readSkill(name: SkillName): string | null;
/** Absolute path to the templates directory. */
export declare function templatesDir(): string;
/** List template filenames present on disk. */
export declare function listTemplates(): string[];
/** Read a template file by name (e.g. 'claude-md-snippet.md'). Returns null if missing. */
export declare function readTemplate(name: string): string | null;
