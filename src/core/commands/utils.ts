import * as fs from 'fs';
import * as path from 'path';
import { InitiativeManager } from '../managers/initiative';

export function today(): string {
  return new Date().toISOString().split('T')[0];
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function findInitiativeFilename(mdocsRoot: string, initiatives: InitiativeManager, id: string): string | null {
  const initiativesDir = path.join(mdocsRoot, 'initiatives');
  if (!fs.existsSync(initiativesDir)) return null;
  const files = fs.readdirSync(initiativesDir).filter(file => file.endsWith('.md') && file !== 'INDEX.md');
  for (const fileName of files) {
    const initiative = initiatives.read(fileName);
    if (initiative?.id === id) return fileName;
  }
  return null;
}
