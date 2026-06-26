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
exports.createMdocsCore = createMdocsCore;
const path = __importStar(require("path"));
const audit_1 = require("./audit");
const registry_1 = require("./commands/registry");
const contract_1 = require("./contract");
const config_1 = require("./config");
const lifecycle_1 = require("./lifecycle");
const initiative_1 = require("./managers/initiative");
const mdocs_1 = require("./managers/mdocs");
const wiki_1 = require("./managers/wiki");
const linter_1 = require("./validation/linter");
const search_1 = require("./search");
const subagent_1 = require("./subagent");
const engine_1 = require("./workflow/engine");
function createMdocsCore(projectDir, options = {}) {
    // Load the opt-in `.mdocs.json` from the preliminary mdocs root (default dir
    // name, or an explicit override) and merge so explicit options win over
    // file, file over built-in defaults. Recompute the root from the merged dir
    // name in case the file redeclares it.
    const preliminaryRoot = path.join(projectDir, options.mdocsDirName || 'mdocs');
    const fileConfig = (0, config_1.loadProjectConfig)(preliminaryRoot);
    const merged = mergeOptions(fileConfig, options);
    const mdocsRoot = path.join(projectDir, merged.mdocsDirName || 'mdocs');
    const compatibility = { ...(merged.wiki?.compatibility || {}), ...(merged.compatibility || {}) };
    const contract = (0, contract_1.detectMdocsContract)(mdocsRoot, compatibility);
    const mdocs = new mdocs_1.MdocsManager(mdocsRoot, compatibility);
    const initiatives = new initiative_1.InitiativeManager(mdocsRoot, { compatibility });
    const wiki = new wiki_1.WikiManager(mdocsRoot, {
        standaloneCategories: merged.wiki?.standaloneCategories ?? merged.standaloneCategories,
        compatibility
    });
    const workflow = new engine_1.WorkflowEngine(mdocsRoot, {
        enforcementMode: contract.enforcementMode,
        idle: contract.idle
    });
    const search = new search_1.SearchEngine(mdocsRoot);
    const audit = new audit_1.AuditLog(mdocsRoot);
    const linter = new linter_1.MdocsLinter(mdocsRoot, { initiativeRecordMode: contract.initiativeRecordMode });
    const dispatch = new subagent_1.SubagentAssembler();
    const lifecycle = new lifecycle_1.MdocsLifecycleService(mdocs, initiatives, merged.bootstrap);
    const commands = new registry_1.MdocsCommandRegistry({
        mdocsRoot,
        mdocs,
        initiatives,
        wiki,
        workflow,
        search,
        audit,
        linter,
        dispatch
    });
    return {
        projectDir,
        mdocsRoot,
        managers: { mdocs, initiatives, wiki, workflow, search, audit, linter, dispatch },
        lifecycle,
        commands,
        contract
    };
}
/**
 * Merge a file-loaded config with explicit options. Explicit options win at
 * the top level; the nested `compatibility` and `wiki` objects merge key-level
 * so a file can set e.g. `enforcementMode` while an explicit option adds
 * `initiativeRecordMode`, each without clobbering the other.
 */
function mergeOptions(file, explicit) {
    const merged = { ...file, ...explicit };
    if (file.compatibility || explicit.compatibility) {
        merged.compatibility = { ...(file.compatibility || {}), ...(explicit.compatibility || {}) };
    }
    if (file.wiki || explicit.wiki) {
        merged.wiki = { ...(file.wiki || {}), ...(explicit.wiki || {}) };
    }
    return merged;
}
//# sourceMappingURL=factory.js.map