"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SKILL_NAMES = void 0;
exports.assetsDir = assetsDir;
exports.skillPath = skillPath;
exports.listSkills = listSkills;
exports.readSkill = readSkill;
exports.templatesDir = templatesDir;
exports.listTemplates = listTemplates;
exports.readTemplate = readTemplate;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Asset resolution for the Claude Code surface.
 *
 * Assets (SKILL.md files, templates, agent prompt) ship at
 *   <pkg>/src/surfaces/claude-code/assets/
 * and are NOT compiled. From the compiled module at
 *   <pkg>/dist/surfaces/claude-code/skills.js
 * the assets dir is three levels up plus the src path.
 */
function assetsDir() {
    return path.resolve(__dirname, '../../../src/surfaces/claude-code/assets');
}
exports.SKILL_NAMES = ['mdocs-workflow', 'mdocs-initiative', 'mdocs-orchestrator'];
/** Absolute path to a skill's SKILL.md. */
function skillPath(name) {
    return path.join(assetsDir(), 'skills', name, 'SKILL.md');
}
/** List the skill names that have a SKILL.md present on disk. */
function listSkills() {
    return exports.SKILL_NAMES.filter(name => fs.existsSync(skillPath(name)));
}
/** Read a skill's SKILL.md content. Returns null if missing. */
function readSkill(name) {
    const p = skillPath(name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
/** Absolute path to the templates directory. */
function templatesDir() {
    return path.join(assetsDir(), 'templates');
}
/** List template filenames present on disk. */
function listTemplates() {
    const dir = templatesDir();
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}
/** Read a template file by name (e.g. 'claude-md-snippet.md'). Returns null if missing. */
function readTemplate(name) {
    const p = path.join(templatesDir(), name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
//# sourceMappingURL=skills.js.map