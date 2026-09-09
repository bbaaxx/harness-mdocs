import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');

test('package files include opencode runtime prompt assets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  expect(packageJson.files).toEqual(expect.arrayContaining(['agents', 'skills', 'docs/*.md']));
});

test('package builds dist during git installs', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  expect(packageJson.scripts.prepare).toBe('npm run build');
});

test('package exposes mdocs CLI bin and repo dogfood shim', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  expect(packageJson.bin).toMatchObject({ mdocs: 'dist/cli/index.js' });
  expect(packageJson.files).toEqual(expect.arrayContaining(['dist']));

  const shim = fs.readFileSync(path.join(root, '.agents', 'bin', 'mdocs'), 'utf8');
  expect(shim).toContain('dist/cli/index.js');
  expect(shim).toContain('npm run build');
});

test('package exports OpenCode runtime entrypoints and compatibility alias', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  expect(packageJson.main).toBe('dist/index.js');
  expect(packageJson.exports['.'].default).toBe('./dist/index.js');
  expect(packageJson.exports['./opencode'].default).toBe('./dist/surfaces/opencode/index.js');
  expect(packageJson.exports['./plugin'].default).toBe('./dist/surfaces/opencode/opencode.js');
  expect(packageJson.exports['./api'].default).toBe('./dist/api.js');
  expect(packageJson.exports['./core'].default).toBe('./dist/core/index.js');
  expect(packageJson.exports['./agents']).toEqual({
    types: './dist/agents/index.d.ts',
    default: './dist/agents/index.js'
  });
  expect(packageJson.exports['./codex'].default).toBe('./dist/surfaces/codex/index.js');
});

test('built agents subpath resolves through package exports', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const agentsExport = packageJson.exports['./agents'];
  const runtimeTarget = path.resolve(root, agentsExport.default);
  const typesTarget = path.resolve(root, agentsExport.types);
  const packageRequire = createRequire(path.join(root, 'package.json'));

  expect(fs.existsSync(runtimeTarget)).toBe(true);
  expect(fs.existsSync(typesTarget)).toBe(true);
  expect(packageRequire.resolve('harness-mdocs/agents')).toBe(runtimeTarget);
  expect(packageRequire('harness-mdocs/agents').canonicalAgentCapabilityRegistry).toBeDefined();
});
