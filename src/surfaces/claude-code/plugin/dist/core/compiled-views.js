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
exports.CompiledViewRegistrar = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const markdown_1 = require("./markdown");
const lock_1 = require("./lock");
/** Comments and fenced examples are not catalog membership or row ownership. */
function visibleMarkdown(content) {
    let fence;
    return content.replace(/<!--[\s\S]*?(?:-->|$)/g, comment => comment.replace(/[^\r\n]/g, ''))
        .split(/\r?\n/).map(line => {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (marker) {
            if (!fence)
                fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line))
                fence = undefined;
            return '';
        }
        return fence ? '' : line;
    }).join('\n');
}
/** Resolve only explicit Markdown destinations/code paths, never prose IDs. */
function containsTarget(content, file, target) {
    content = visibleMarkdown(content);
    const refs = [
        ...Array.from(content.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g), match => match[1]),
        ...Array.from(content.matchAll(/`((?:\.\/)?[A-Za-z0-9][A-Za-z0-9._/-]*(?:\/|\.md))`/g), match => match[1])
    ];
    return refs.some(ref => {
        if (/^[a-z]+:/i.test(ref))
            return false;
        const destination = ref.split(/[?#]/)[0];
        return path.resolve(path.dirname(file), destination) === path.resolve(target);
    });
}
function label(title) {
    return title.replace(/[\r\n]+/g, ' ').replace(/([\\[\]<>])/g, '\\$1');
}
/** Explicit, opt-in, per-row registration. Curated rows remain user-owned. */
class CompiledViewRegistrar {
    root;
    contract;
    initiatives;
    wiki;
    constructor(root, contract, initiatives, wiki) {
        this.root = root;
        this.contract = contract;
        this.initiatives = initiatives;
        this.wiki = wiki;
    }
    register(input) {
        if (!Array.isArray(input) || input.length === 0)
            return { success: false, error: 'index.sync registrations must be a non-empty array' };
        if (this.contract.initiativeMode !== 'directory')
            return { success: false, error: 'Targeted registrations require directory-v2 initiatives' };
        if (this.contract.compiledViewMutationMode !== 'targeted') {
            return { success: true, regenerated: [], skipped: true, reason: 'external-owner', registrations: input.map(registration => ({ registration, skipped: true, reason: 'external-owner' })) };
        }
        if (this.contract.wikiIndexOwner !== 'external' || this.contract.wikiIndexMode !== 'canonical-lowercase') {
            return { success: false, error: 'Targeted registrations require an externally owned canonical-lowercase wiki index' };
        }
        const result = (0, lock_1.withLock)(this.root, 'compiled-views', () => this.apply(input));
        return result.ran ? result.value : { success: false, error: 'compiled-view registration lock timeout' };
    }
    row(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new Error('Invalid compiled-view registration');
        const allowed = input.type === 'wiki' ? ['type', 'ref'] : input.type === 'initiative' ? ['type', 'id'] : ['type', 'initiativeId'];
        if (Object.keys(input).some(key => !allowed.includes(key)))
            throw new Error('Unsupported compiled-view registration fields');
        if (input.type === 'wiki') {
            if (typeof input.ref !== 'string' || !/^[\w-]+(?:\/[\w-]+)?$/.test(input.ref))
                throw new Error('Wiki registration requires a canonical ref');
            const entry = this.wiki.readByRef(input.ref);
            if (!entry)
                throw new Error(`Wiki entry not found: ${input.ref}`);
            const target = path.join(this.root, 'wiki', entry.category, `${entry.id}.md`);
            // Compiled root views are not entries in their own catalog.
            if (!entry.category && ['index', 'overview', 'log', 'glossary'].includes(entry.id))
                throw new Error('Cannot register a compiled root view');
            return { file: path.join(this.root, 'wiki', 'index.md'), target, key: `wiki:${input.ref}`, text: `[${label(entry.title)}](${input.ref}.md)${entry.status ? ` — status: ${label(entry.status)}` : ''}` };
        }
        if (input.type !== 'initiative' && input.type !== 'overview')
            throw new Error(`Unsupported registration type: ${input.type}`);
        const id = input.type === 'initiative' ? input.id : input.initiativeId;
        if (typeof id !== 'string')
            throw new Error('Initiative registration requires id');
        const key = this.initiatives.findKeyById(id);
        const initiative = key ? this.initiatives.read(key) : null;
        if (!key || !initiative || !/^[\w-]+$/.test(key) || !fs.existsSync(path.join(this.root, 'initiatives', key, '_status.md')))
            throw new Error(`Directory initiative not found: ${id}`);
        if (input.type === 'initiative') {
            return { file: path.join(this.root, 'initiatives', 'INDEX.md'), target: path.join(this.root, 'initiatives', key), key: `initiative:${key}`, text: `[${label(initiative.title)}](${key}/) — status: ${initiative.status}` };
        }
        if (initiative.status !== 'active')
            throw new Error(`Overview registration requires an active initiative: ${id}`);
        const compiled = this.wiki.list().find(entry => ['initiatives', 'initiative'].includes(entry.category) && entry.id === initiative.id);
        if (!compiled)
            throw new Error(`Compiled initiative wiki page not found: ${id}`);
        const ref = `${compiled.category}/${compiled.id}.md`;
        return { file: path.join(this.root, 'wiki', 'overview.md'), target: path.join(this.root, 'wiki', ref), key: `overview:${key}`, text: `[${label(initiative.title)}](${ref}) — status: ${initiative.status}` };
    }
    apply(input) {
        const before = new Map();
        const after = new Map();
        const rows = [];
        try {
            // Validate and compose the entire batch before writing its first byte.
            for (const registration of input) {
                const row = this.row(registration);
                rows.push(row);
                if (!before.has(row.file)) {
                    if (!fs.existsSync(row.file) || !fs.lstatSync(row.file).isFile())
                        throw new Error(`Compiled view must be an existing regular file: ${path.relative(this.root, row.file)}`);
                    const realRelative = path.relative(fs.realpathSync(this.root), fs.realpathSync(row.file));
                    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative))
                        throw new Error('Compiled view resolves outside mdocs root');
                    before.set(row.file, fs.readFileSync(row.file, 'utf8'));
                    after.set(row.file, before.get(row.file));
                }
                let content = after.get(row.file);
                const originalContent = content;
                const newline = content.includes('\r\n') ? '\r\n' : '\n';
                const marker = `<!-- mdocs:registration ${row.key} -->`;
                const lines = Array.from(content.matchAll(/[^\n]*(?:\n|$)/g)).filter(match => match[0]);
                const visible = visibleMarkdown(content).split('\n');
                const managedRows = lines.filter((match, index) => match[0].replace(/\r?\n$/, '').endsWith(marker) && visible[index].startsWith('- '));
                if (managedRows.length > 1)
                    throw new Error(`Duplicate registration markers: ${row.key}`);
                const managed = managedRows[0];
                const nextLine = `- ${row.text} ${marker}`;
                if (managed) {
                    const ending = managed[0].match(/\r?\n$/)?.[0] || '';
                    content = content.slice(0, managed.index) + nextLine + ending + content.slice(managed.index + managed[0].length);
                }
                else if (!containsTarget(content, row.file, row.target)) {
                    content += `${content.endsWith(newline) ? '' : newline}${nextLine}${newline}`;
                }
                row.changed = content !== originalContent;
                after.set(row.file, content);
            }
            const written = [];
            try {
                for (const [file, content] of after) {
                    if (content === before.get(file))
                        continue;
                    if (fs.readFileSync(file, 'utf8') !== before.get(file))
                        throw new Error(`Compiled view changed during registration: ${file}`);
                    (0, markdown_1.atomicWrite)(file, content);
                    written.push(file);
                }
                for (const row of rows) {
                    if (!containsTarget(fs.readFileSync(row.file, 'utf8'), row.file, row.target))
                        throw new Error(`Registration postcondition failed: ${row.key}`);
                }
            }
            catch (error) {
                const rollbackErrors = [];
                for (const file of written.reverse()) {
                    try {
                        (0, markdown_1.atomicWrite)(file, before.get(file));
                    }
                    catch (rollback) {
                        rollbackErrors.push(rollback.message);
                    }
                }
                return { success: false, error: error.message, rolledBack: rollbackErrors.length === 0, rollbackErrors, regenerated: [] };
            }
            return {
                success: true,
                regenerated: written.map(file => path.relative(this.root, file)),
                registrations: rows.map(row => ({ key: row.key, file: path.relative(this.root, row.file), verified: true, changed: row.changed }))
            };
        }
        catch (error) {
            return { success: false, error: error.message, regenerated: [] };
        }
    }
}
exports.CompiledViewRegistrar = CompiledViewRegistrar;
//# sourceMappingURL=compiled-views.js.map