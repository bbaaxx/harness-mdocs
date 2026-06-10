import * as fs from 'fs';
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

test('package exports OpenCode runtime entrypoints and compatibility alias', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  expect(packageJson.main).toBe('dist/index.js');
  expect(packageJson.exports['.'].default).toBe('./dist/index.js');
  expect(packageJson.exports['./opencode'].default).toBe('./dist/surfaces/opencode/index.js');
  expect(packageJson.exports['./plugin'].default).toBe('./dist/surfaces/opencode/opencode.js');
  expect(packageJson.exports['./api'].default).toBe('./dist/api.js');
  expect(packageJson.exports['./core'].default).toBe('./dist/core/index.js');
  expect(packageJson.exports['./codex'].default).toBe('./dist/surfaces/codex/index.js');
});
