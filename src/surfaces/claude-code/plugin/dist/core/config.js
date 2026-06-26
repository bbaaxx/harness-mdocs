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
exports.loadProjectConfig = loadProjectConfig;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Load the opt-in project-level `.mdocs.json` config file.
 *
 * Reads `<mdocsRoot>/.mdocs.json` and returns the parsed subset that maps to
 * {@link MdocsCoreOptions}: `mdocsDirName`, `standaloneCategories`,
 * `compatibility`, and the nested `wiki` options. Returns `{}` when the file
 * is missing or invalid — this loader NEVER throws, so a malformed config
 * degrades gracefully to defaults instead of breaking core construction.
 *
 * Precedence is applied by the caller (the factory): explicit `options` win
 * over file, file wins over built-in defaults. The "file" precedence tier is
 * established here; before this module the runtime path only honored explicit
 * options and built-in defaults.
 */
function loadProjectConfig(mdocsRoot) {
    const configPath = path.join(mdocsRoot, '.mdocs.json');
    let raw;
    try {
        raw = fs.readFileSync(configPath, 'utf8');
    }
    catch {
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
    }
    const source = parsed;
    const config = {};
    if (typeof source.mdocsDirName === 'string' && source.mdocsDirName.length > 0) {
        config.mdocsDirName = source.mdocsDirName;
    }
    if (Array.isArray(source.standaloneCategories)) {
        const categories = source.standaloneCategories.filter((category) => typeof category === 'string');
        if (categories.length > 0) {
            config.standaloneCategories = categories;
        }
    }
    if (isPlainObject(source.compatibility)) {
        config.compatibility = source.compatibility;
    }
    if (isPlainObject(source.wiki)) {
        config.wiki = source.wiki;
    }
    return config;
}
function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=config.js.map