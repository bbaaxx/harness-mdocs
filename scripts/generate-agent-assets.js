#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-generator-'));

try {
  const tsc = require.resolve('typescript/bin/tsc', { paths: [root] });
  const compiled = spawnSync(process.execPath, [
    tsc,
    path.join(root, 'src/generation/generator.ts'),
    path.join(root, 'src/generation/manifest.ts'),
    path.join(root, 'src/generation/index.ts'),
    '--outDir', temporary,
    '--rootDir', path.join(root, 'src'),
    '--target', 'ES2022',
    '--module', 'CommonJS',
    '--moduleResolution', 'Node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--declaration', 'false',
    '--sourceMap', 'false',
    '--strict'
  ], { cwd: root, stdio: 'inherit' });
  if (compiled.status !== 0) {
    process.stderr.write('Refusing to run generator because exact source compilation failed.\n');
    process.exitCode = compiled.status || 1;
  } else {
    const {
      AGENT_ASSET_GENERATION,
      checkGeneratedAssets,
      generateAssets
    } = require(path.join(temporary, 'generation'));
    const mode = process.argv[2] || '--generate';

    if (mode === '--check') {
      const result = checkGeneratedAssets(root, AGENT_ASSET_GENERATION);
      if (result.clean) {
        process.stdout.write('Generated agent assets are clean.\n');
      } else {
        for (const category of [
          'missing', 'byteDrifted', 'provenanceDrifted', 'stale', 'pendingTransaction'
        ]) {
          for (const file of result[category]) process.stderr.write(`${category}: ${file}\n`);
        }
        process.exitCode = 1;
      }
    } else if (mode === '--generate') {
      const result = generateAssets(root, AGENT_ASSET_GENERATION);
      for (const file of result.written) process.stdout.write(`written: ${file}\n`);
      for (const file of result.deleted) process.stdout.write(`deleted: ${file}\n`);
      for (const rename of result.renamed) {
        process.stdout.write(`renamed: ${rename.from} -> ${rename.to}\n`);
      }
      if (result.recoveredTransaction) process.stdout.write('recovered: interrupted transaction\n');
    } else {
      process.stderr.write('Usage: node scripts/generate-agent-assets.js [--generate|--check]\n');
      process.exitCode = 2;
    }
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
