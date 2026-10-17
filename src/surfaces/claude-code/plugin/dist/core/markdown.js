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
exports.atomicWrite = atomicWrite;
exports.markdownSections = markdownSections;
exports.readMarkdownSection = readMarkdownSection;
exports.readMarkdownList = readMarkdownList;
exports.writeMarkdownSection = writeMarkdownSection;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
/** Replace a file only after the complete replacement has been written. */
function atomicWrite(filePath, content) {
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${(0, crypto_1.randomUUID)()}.tmp`);
    try {
        fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: fs.statSync(filePath).mode });
        fs.renameSync(temporary, filePath);
    }
    finally {
        if (fs.existsSync(temporary))
            fs.unlinkSync(temporary);
    }
}
/** Top-level section boundaries, excluding headings inside fenced code. */
function markdownSections(content) {
    const sections = [];
    let fence;
    for (const match of content.matchAll(/[^\n]*(?:\n|$)/g)) {
        if (!match[0])
            continue;
        const line = match[0].replace(/\r?\n$/, '');
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (marker) {
            if (!fence)
                fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line))
                fence = undefined;
            continue;
        }
        if (fence)
            continue;
        const heading = line.match(/^## (.+?)\s*$/);
        if (heading) {
            if (sections.length)
                sections[sections.length - 1].end = match.index;
            sections.push({ name: heading[1], start: match.index, body: match.index + match[0].length, end: content.length });
        }
    }
    return sections;
}
function readMarkdownSection(content, name) {
    const section = markdownSections(content).find(item => item.name === name);
    return section ? content.slice(section.body, section.end).trim() : '';
}
function readMarkdownList(content, name) {
    const entries = [];
    let fence;
    for (const line of readMarkdownSection(content, name).split(/\r?\n/)) {
        const marker = line.match(/^\s*(`{3,}|~{3,})/);
        if (!fence && line.startsWith('- '))
            entries.push(line.slice(2));
        else if (entries.length)
            entries[entries.length - 1] += `\n${line}`;
        if (marker) {
            if (!fence)
                fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*(`+|~+)\s*$/.test(line))
                fence = undefined;
        }
    }
    return entries.map(entry => entry.trimEnd());
}
function writeMarkdownSection(content, name, value, append = false) {
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    value = value.replace(/\r?\n/g, newline);
    const section = markdownSections(content).find(item => item.name === name);
    if (!section)
        return `${content}${content.endsWith(newline) ? newline : newline + newline}## ${name}${newline}${value}${newline}`;
    const oldBody = content.slice(section.body, section.end);
    // Keep hard-break spaces on the last content line attached to that line.
    const trailing = oldBody.match(/(?:\r?\n[ \t]*)*$/)[0];
    const prefix = append ? oldBody.slice(0, oldBody.length - trailing.length) : '';
    const body = `${prefix}${prefix ? newline : ''}${value}${trailing || newline}`;
    const heading = content.slice(0, section.body);
    return heading + (heading.endsWith('\n') ? '' : newline) + body + content.slice(section.end);
}
//# sourceMappingURL=markdown.js.map