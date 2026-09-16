#!/usr/bin/env node
// Stamps the package.json version into derived manifests so package.json stays
// the single source of truth:
//   - src/surfaces/claude-code/plugin/.claude-plugin/plugin.json (.version)
//   - .claude-plugin/marketplace.json (.plugins[].version)
// Idempotent: files already in sync are left untouched (git stays clean).
// --check: report drift and exit 1 without writing (for CI / quality gate).
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const checkOnly = process.argv.includes('--check');

const TARGETS = [
  'src/surfaces/claude-code/plugin/.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
];

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  console.error('stamp-versions: package.json has no usable "version"');
  process.exit(1);
}

const VERSION_FIELD = /("version"\s*:\s*")[^"]*(")/g;

let drifted = [];
let stamped = [];

for (const rel of TARGETS) {
  const abs = path.join(repoRoot, rel);
  const original = fs.readFileSync(abs, 'utf8');
  const matches = original.match(VERSION_FIELD);
  if (!matches || matches.length === 0) {
    console.error(`stamp-versions: no "version" field found in ${rel}`);
    process.exit(1);
  }
  const updated = original.replace(VERSION_FIELD, `$1${version}$2`);
  if (updated === original) continue;
  drifted.push(rel);
  if (!checkOnly) {
    fs.writeFileSync(abs, updated);
    stamped.push(rel);
  }
}

if (checkOnly) {
  if (drifted.length > 0) {
    console.error(`stamp-versions: drift detected (package.json=${version}):`);
    for (const rel of drifted) console.error(`  - ${rel}`);
    console.error('Run `npm run build` (or `node scripts/stamp-versions.js`) to stamp.');
    process.exit(1);
  }
  console.log(`stamp-versions: all manifests in sync at ${version}`);
} else {
  if (stamped.length > 0) {
    console.log(`stamp-versions: stamped ${version} into:`);
    for (const rel of stamped) console.log(`  - ${rel}`);
  } else {
    console.log(`stamp-versions: already in sync at ${version}`);
  }
}
