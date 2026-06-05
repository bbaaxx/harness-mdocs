import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');

test('package files include opencode runtime prompt assets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  expect(packageJson.files).toEqual(expect.arrayContaining(['agents', 'skills']));
});
