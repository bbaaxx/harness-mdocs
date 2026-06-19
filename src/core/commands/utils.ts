import { InitiativeManager } from '../managers/initiative';

export function today(): string {
  return new Date().toISOString().split('T')[0];
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function findInitiativeFilename(mdocsRoot: string, initiatives: InitiativeManager, id: string): string | null {
  void mdocsRoot;
  return initiatives.findKeyById(id);
}
