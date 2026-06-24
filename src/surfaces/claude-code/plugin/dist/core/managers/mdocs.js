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
exports.MdocsManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const contract_1 = require("../contract");
class MdocsManager {
    baseDir;
    contract;
    constructor(baseDir, compatibility = {}) {
        if (!baseDir || typeof baseDir !== 'string') {
            throw new Error('baseDir must be a non-empty string');
        }
        this.baseDir = path.resolve(baseDir);
        this.contract = (0, contract_1.detectMdocsContract)(this.baseDir, compatibility);
    }
    init() {
        const initiativesDir = path.join(this.baseDir, 'initiatives');
        const wikiDir = path.join(this.baseDir, 'wiki');
        fs.mkdirSync(initiativesDir, { recursive: true });
        fs.mkdirSync(wikiDir, { recursive: true });
        this.writeIndex(path.join(initiativesDir, 'INDEX.md'), '# Initiatives\n\nNo initiatives yet.');
        if (this.contract.wikiIndexMode === 'generated-uppercase') {
            this.writeIndex(path.join(wikiDir, 'INDEX.md'), '# Wiki\n\nNo entries yet.');
        }
        else if (this.contract.wikiIndexMode === 'canonical-lowercase') {
            this.writeIndex(path.join(wikiDir, 'index.md'), '# Wiki\n\nNo entries yet.');
        }
    }
    writeIndex(filePath, content) {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, content, 'utf8');
        }
    }
    exists() {
        const initiativesPath = path.join(this.baseDir, 'initiatives');
        const wikiPath = path.join(this.baseDir, 'wiki');
        const initiativesIndex = path.join(initiativesPath, 'INDEX.md');
        const wikiIndex = this.contract.wikiIndexMode === 'canonical-lowercase'
            ? path.join(wikiPath, 'index.md')
            : path.join(wikiPath, 'INDEX.md');
        const hasDirectoryInitiative = this.hasDirectoryInitiative(initiativesPath);
        return fs.existsSync(initiativesPath) &&
            fs.existsSync(wikiPath) &&
            fs.statSync(initiativesPath).isDirectory() &&
            fs.statSync(wikiPath).isDirectory() &&
            (fs.existsSync(initiativesIndex) || this.contract.initiativeMode === 'directory' || hasDirectoryInitiative) &&
            (this.contract.wikiIndexMode === 'none' || fs.existsSync(wikiIndex));
    }
    hasDirectoryInitiative(initiativesPath) {
        if (!fs.existsSync(initiativesPath) || !fs.statSync(initiativesPath).isDirectory())
            return false;
        return fs.readdirSync(initiativesPath, { withFileTypes: true }).some(entry => {
            if (!entry.isDirectory() || entry.name === 'archive' || entry.name === '_archive')
                return false;
            return fs.existsSync(path.join(initiativesPath, entry.name, '_status.md'));
        });
    }
    getMetaPath() {
        return path.join(this.baseDir, '.index-meta.json');
    }
    writeIndexMeta() {
        const metaPath = this.getMetaPath();
        const meta = { lastSync: new Date().toISOString() };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }
    readIndexMeta() {
        const metaPath = this.getMetaPath();
        if (!fs.existsSync(metaPath)) {
            return { lastSync: null };
        }
        try {
            const content = fs.readFileSync(metaPath, 'utf8');
            const meta = JSON.parse(content);
            return { lastSync: meta.lastSync || null };
        }
        catch {
            return { lastSync: null };
        }
    }
}
exports.MdocsManager = MdocsManager;
//# sourceMappingURL=mdocs.js.map