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
exports.detectMdocsContract = detectMdocsContract;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function safeExists(filePath) {
    try {
        return fs.existsSync(filePath);
    }
    catch {
        return false;
    }
}
/**
 * Validate an explicit `wikiIndexOwner` override against the resolved mode.
 * `'harness'` is permitted for both generated-uppercase (default) and
 * canonical-lowercase (opt-in). `'external'` is only meaningful for
 * canonical-lowercase. `'none'` applies when there is no index.
 */
function isValidOwnerForMode(owner, mode) {
    if (owner === 'harness')
        return mode === 'generated-uppercase' || mode === 'canonical-lowercase';
    if (owner === 'external')
        return mode === 'canonical-lowercase';
    if (owner === 'none')
        return mode === 'none';
    return false;
}
function hasExactChild(parentDir, childName) {
    if (!safeExists(parentDir))
        return false;
    try {
        return fs.readdirSync(parentDir).includes(childName);
    }
    catch {
        return false;
    }
}
function hasDirectoryInitiatives(initiativesDir) {
    if (!safeExists(initiativesDir))
        return false;
    try {
        return fs.readdirSync(initiativesDir, { withFileTypes: true }).some(entry => {
            if (!entry.isDirectory() || entry.name === 'archive' || entry.name === '_archive')
                return false;
            return safeExists(path.join(initiativesDir, entry.name, '_status.md'));
        });
    }
    catch {
        return false;
    }
}
function hasFlatInitiatives(initiativesDir) {
    if (!safeExists(initiativesDir))
        return false;
    try {
        return fs.readdirSync(initiativesDir).some(file => file.endsWith('.md') && file !== 'INDEX.md');
    }
    catch {
        return false;
    }
}
function schemaMentionsDirectoryStatus(mdocsRoot) {
    const schemaPath = path.join(mdocsRoot, 'SCHEMA.md');
    if (!safeExists(schemaPath))
        return false;
    try {
        return fs.readFileSync(schemaPath, 'utf8').includes('_status.md');
    }
    catch {
        return false;
    }
}
function detectMdocsContract(mdocsRoot, config = {}) {
    const initiativesDir = path.join(mdocsRoot, 'initiatives');
    const wikiDir = path.join(mdocsRoot, 'wiki');
    const directorySignals = hasDirectoryInitiatives(initiativesDir) || schemaMentionsDirectoryStatus(mdocsRoot);
    const lowercaseWikiIndex = hasExactChild(wikiDir, 'index.md');
    const uppercaseWikiIndex = hasExactChild(wikiDir, 'INDEX.md');
    const underscoreArchive = safeExists(path.join(initiativesDir, '_archive'));
    const flatInitiatives = hasFlatInitiatives(initiativesDir);
    const obsidianDir = path.join(mdocsRoot, '_obsidian');
    const obsidianVisibilityLayer = safeExists(obsidianDir) && isDirectory(obsidianDir);
    const initiativeMode = config.initiativeMode && config.initiativeMode !== 'auto'
        ? config.initiativeMode
        : directorySignals
            ? 'directory'
            : 'flat';
    const wikiIndexMode = config.wikiIndexMode && config.wikiIndexMode !== 'auto'
        ? config.wikiIndexMode
        : directorySignals
            ? lowercaseWikiIndex
                ? 'canonical-lowercase'
                : 'none'
            : lowercaseWikiIndex && !uppercaseWikiIndex
                ? 'canonical-lowercase'
                : 'generated-uppercase';
    const archiveDir = config.archiveDir && config.archiveDir !== 'auto'
        ? config.archiveDir
        : underscoreArchive
            ? '_archive'
            : 'archive';
    const legacyFlatFiles = config.legacyFlatFiles === 'auto' || config.legacyFlatFiles === undefined
        ? flatInitiatives
        : config.legacyFlatFiles;
    // Wiki index owner. Defaults are safe: harness owns generated-uppercase,
    // external owns canonical-lowercase (directory-v2), none when there is no
    // index. The `wikiIndexOwner` config is an explicit opt-in/override and is
    // validated against the resolved mode so nonsense combinations fall back to
    // the safe default rather than silently clobbering an external index.
    const defaultWikiIndexOwner = wikiIndexMode === 'generated-uppercase'
        ? 'harness'
        : wikiIndexMode === 'canonical-lowercase'
            ? 'external'
            : 'none';
    const configuredOwner = config.wikiIndexOwner;
    const wikiIndexOwner = configuredOwner && isValidOwnerForMode(configuredOwner, wikiIndexMode)
        ? configuredOwner
        : defaultWikiIndexOwner;
    return {
        initiativeMode,
        wikiIndexMode,
        archiveDir,
        legacyFlatFiles,
        wikiIndexOwner,
        obsidianVisibilityLayer,
        obsidianDir: obsidianVisibilityLayer ? obsidianDir : undefined,
        obsidianRefreshCommand: config.obsidianRefreshCommand ?? null,
        enforcementMode: resolveEnforcementMode(config.enforcementMode),
        idle: resolveIdleStrictness(config.idle),
        initiativeRecordMode: config.initiativeRecordMode ?? 'full'
    };
}
/**
 * Resolve the enforcement mode with precedence: env > file/config > default.
 * `MDOCS_ENFORCEMENT` is the CI escape hatch (`off` disables the gate
 * entirely); `gate` is the default.
 */
function resolveEnforcementMode(configValue) {
    const envValue = typeof process !== 'undefined' && process.env?.MDOCS_ENFORCEMENT;
    if (envValue === 'gate' || envValue === 'advisory' || envValue === 'off')
        return envValue;
    return configValue ?? 'gate';
}
/**
 * Resolve IDLE strictness with precedence: env > file/config > default.
 * `MDOCS_ENFORCEMENT_IDLE=readonly` tightens IDLE to read-only; `open` is
 * the 0.4.2 default.
 */
function resolveIdleStrictness(configValue) {
    const envValue = typeof process !== 'undefined' && process.env?.MDOCS_ENFORCEMENT_IDLE;
    if (envValue === 'readonly' || envValue === 'open')
        return envValue;
    return configValue ?? 'open';
}
function isDirectory(filePath) {
    try {
        return fs.statSync(filePath).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=contract.js.map