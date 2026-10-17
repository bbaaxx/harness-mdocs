import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** Replace a file only after the complete replacement has been written. */
export function atomicWrite(filePath: string, content: string): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: fs.statSync(filePath).mode });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Top-level section boundaries, excluding headings inside fenced code. */
export function markdownSections(content: string): Array<{ name: string; start: number; body: number; end: number }> {
  const sections: Array<{ name: string; start: number; body: number; end: number }> = [];
  let fence: string | undefined;
  for (const match of content.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].replace(/\r?\n$/, '');
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^## (.+?)\s*$/);
    if (heading) {
      if (sections.length) sections[sections.length - 1].end = match.index!;
      sections.push({ name: heading[1], start: match.index!, body: match.index! + match[0].length, end: content.length });
    }
  }
  return sections;
}

export function readMarkdownSection(content: string, name: string): string {
  const section = markdownSections(content).find(item => item.name === name);
  return section ? content.slice(section.body, section.end).trim() : '';
}

export function readMarkdownList(content: string, name: string): string[] {
  const entries: string[] = [];
  let fence: string | undefined;
  for (const line of readMarkdownSection(content, name).split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (!fence && line.startsWith('- ')) entries.push(line.slice(2));
    else if (entries.length) entries[entries.length - 1] += `\n${line}`;
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*(`+|~+)\s*$/.test(line)) fence = undefined;
    }
  }
  return entries.map(entry => entry.trimEnd());
}

export function writeMarkdownSection(content: string, name: string, value: string, append = false): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  value = value.replace(/\r?\n/g, newline);
  const section = markdownSections(content).find(item => item.name === name);
  if (!section) return `${content}${content.endsWith(newline) ? newline : newline + newline}## ${name}${newline}${value}${newline}`;
  const oldBody = content.slice(section.body, section.end);
  // Keep hard-break spaces on the last content line attached to that line.
  const trailing = oldBody.match(/(?:\r?\n[ \t]*)*$/)![0];
  const prefix = append ? oldBody.slice(0, oldBody.length - trailing.length) : '';
  const body = `${prefix}${prefix ? newline : ''}${value}${trailing || newline}`;
  const heading = content.slice(0, section.body);
  return heading + (heading.endsWith('\n') ? '' : newline) + body + content.slice(section.end);
}
