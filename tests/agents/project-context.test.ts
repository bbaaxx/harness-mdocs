import * as crypto from 'crypto';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ts from 'typescript';

import {
  createProjectReadContext,
  ProjectContextError
} from '../../src/agents/project-context';

function createFixture(): { tempRoot: string; projectRoot: string; outsideRoot: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-project-context-'));
  const projectRoot = path.join(tempRoot, 'project');
  const outsideRoot = path.join(tempRoot, 'outside');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(outsideRoot);
  return { tempRoot, projectRoot, outsideRoot };
}

function rawTree(root: string): string {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const reference = path.relative(root, target).split(path.sep).join('/');
      const stats = fs.lstatSync(target);
      if (stats.isDirectory()) {
        entries.push(`${reference}:directory`);
        visit(target);
      } else if (stats.isSymbolicLink()) {
        entries.push(`${reference}:symlink:${fs.readlinkSync(target)}`);
      } else {
        entries.push(`${reference}:file:${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`);
      }
    }
  };
  visit(root);
  return JSON.stringify(entries);
}

function recursiveState(root: string): string {
  const entries: Array<Record<string, string | number>> = [];
  const visit = (target: string): void => {
    const stats = fs.lstatSync(target);
    entries.push({
      reference: path.relative(root, target).split(path.sep).join('/') || '.',
      mode: stats.mode,
      uid: stats.uid,
      gid: stats.gid,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs
    });
    if (stats.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
    }
  };
  visit(root);
  return JSON.stringify(entries);
}

function expectContextError(action: () => unknown, code: ProjectContextError['code']): void {
  try {
    action();
    throw new Error('Expected ProjectContextError');
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectContextError);
    expect((error as ProjectContextError).code).toBe(code);
  }
}

describe('ProjectReadContext', () => {
  test('fresh project reads do not create mdocs or change tree bytes', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.projectRoot, 'package.json'), '{"name":"fixture"}', 'utf8');
    const before = rawTree(fixture.projectRoot);

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      expect(context.resolve('mdocs')).toBeNull();
      expect(context.exists('mdocs')).toBe(false);
      expect(context.readText('mdocs/config.json')).toBeNull();
      expect(context.readJson('mdocs/config.json')).toBeNull();
      expect(context.list('mdocs')).toEqual([]);
      expect(context.snapshot('mdocs')).toEqual([]);
      expect(context.list().map(entry => entry.name)).toEqual(['package.json']);
      expect(context.snapshot()).toHaveLength(1);

      expect(fs.existsSync(path.join(fixture.projectRoot, 'mdocs'))).toBe(false);
      expect(rawTree(fixture.projectRoot)).toBe(before);
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('all reads call zero filesystem mutation APIs', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.projectRoot, 'package.json'), '{}', 'utf8');
    const outsideSentinel = path.join(fixture.outsideRoot, 'sentinel.txt');
    fs.writeFileSync(outsideSentinel, 'outside-sentinel', 'utf8');
    const beforeProject = recursiveState(fixture.projectRoot);
    const beforeOutside = recursiveState(fixture.outsideRoot);
    const restorers: Array<() => void> = [];
    const fail = (name: string) => (): never => {
      throw new Error(`Filesystem mutation attempted through ${name}`);
    };
    const install = (owner: object, method: string, label: string): void => {
      const descriptor = Object.getOwnPropertyDescriptor(owner, method);
      if (typeof (owner as Record<string, unknown>)[method] !== 'function' || descriptor?.configurable === false) return;
      const spy = jest.spyOn(owner as never, method as never).mockImplementation(fail(label) as never);
      restorers.push(() => spy.mockRestore());
    };
    const originalOpenSync = fs.openSync.bind(fs);
    const forbiddenOpenFlags = fs.constants.O_WRONLY |
      fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      fs.constants.O_APPEND;
    const allowedOpenFlags = (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0);
    const openSyncSpy = jest.spyOn(fs, 'openSync').mockImplementation(((
      target: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode
    ) => {
      if (
        typeof flags !== 'number' ||
        (flags & forbiddenOpenFlags) !== 0 ||
        (flags & ~allowedOpenFlags) !== fs.constants.O_RDONLY
      ) {
        throw new Error(`Filesystem mutation attempted through fs.openSync flags=${String(flags)}`);
      }
      return originalOpenSync(target, flags, mode);
    }) as typeof fs.openSync);
    restorers.push(() => openSyncSpy.mockRestore());
    const syncMutations = [
      'appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync', 'cpSync',
      'fchmodSync', 'fchownSync', 'ftruncateSync', 'futimesSync', 'lchmodSync',
      'lchownSync', 'linkSync', 'lutimesSync', 'mkdirSync', 'mkdtempSync',
      'renameSync', 'rmSync', 'rmdirSync', 'symlinkSync', 'truncateSync',
      'unlinkSync', 'utimesSync', 'writeFileSync', 'writeSync', 'writevSync'
    ];
    const callbackMutations = [
      'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'fchmod', 'fchown',
      'ftruncate', 'futimes', 'lchmod', 'lchown', 'link', 'lutimes', 'mkdir',
      'mkdtemp', 'open', 'rename', 'rm', 'rmdir', 'symlink', 'truncate',
      'unlink', 'utimes', 'write', 'writeFile', 'writev', 'createWriteStream'
    ];
    const promiseMutations = [
      'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchmod', 'lchown',
      'link', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'rename', 'rm', 'rmdir',
      'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'
    ];
    for (const method of syncMutations) install(fs, method, `fs.${method}`);
    for (const method of callbackMutations) install(fs, method, `fs.${method}`);
    for (const method of promiseMutations) install(fs.promises, method, `fs.promises.${method}`);
    install(fs, 'WriteStream', 'new fs.WriteStream');

    try {
      expect(() => fs.openSync(path.join(fixture.projectRoot, 'package.json'), fs.constants.O_WRONLY))
        .toThrow('Filesystem mutation attempted through fs.openSync');
      const DirectWriteStream = fs.WriteStream as unknown as new (filename: string) => fs.WriteStream;
      expect(() => new DirectWriteStream(path.join(fixture.projectRoot, 'blocked.txt')))
        .toThrow('Filesystem mutation attempted through new fs.WriteStream');
      const context = createProjectReadContext(fixture.projectRoot);
      context.resolve('package.json');
      context.exists('missing.json');
      context.readText('package.json');
      context.readJson('package.json');
      context.list();
      context.snapshot();
      expect(recursiveState(fixture.projectRoot)).toBe(beforeProject);
      expect(recursiveState(fixture.outsideRoot)).toBe(beforeOutside);
      expect(fs.readFileSync(outsideSentinel, 'utf8')).toBe('outside-sentinel');
    } finally {
      for (const restore of restorers.reverse()) restore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('all APIs work with read-only files and directories', () => {
    const fixture = createFixture();
    const configDir = path.join(fixture.projectRoot, 'config');
    const configFile = path.join(configDir, 'route.json');
    fs.mkdirSync(configDir);
    fs.writeFileSync(configFile, '{"enabled":true}', 'utf8');
    fs.chmodSync(configFile, 0o444);
    fs.chmodSync(configDir, 0o555);
    fs.chmodSync(fixture.projectRoot, 0o555);

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      expect(context.resolve('config/route.json')).toBe(fs.realpathSync(configFile));
      expect(context.exists('config/route.json')).toBe(true);
      expect(context.readText('config/route.json')).toBe('{"enabled":true}');
      expect(context.readJson('config/route.json')).toEqual({ enabled: true });
      expect(context.list('config')).toEqual([{ name: 'route.json', kind: 'file' }]);
      expect(context.snapshot()).toEqual(expect.arrayContaining([
        expect.objectContaining({ reference: 'config/route.json', kind: 'file' })
      ]));
    } finally {
      fs.chmodSync(fixture.projectRoot, 0o755);
      fs.chmodSync(configDir, 0o755);
      fs.chmodSync(configFile, 0o644);
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('list and snapshot ordering and hashes are deterministic', () => {
    const fixture = createFixture();
    fs.mkdirSync(path.join(fixture.projectRoot, 'z-dir'));
    fs.writeFileSync(path.join(fixture.projectRoot, 'z-dir', 'b.txt'), 'bravo', 'utf8');
    fs.writeFileSync(path.join(fixture.projectRoot, 'z-dir', 'a.txt'), 'alpha', 'utf8');
    fs.writeFileSync(path.join(fixture.projectRoot, 'm.txt'), 'middle', 'utf8');
    fs.mkdirSync(path.join(fixture.projectRoot, 'a-dir'));

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      expect(context.list().map(entry => entry.name)).toEqual(['a-dir', 'm.txt', 'z-dir']);
      const first = context.snapshot();
      fs.rmSync(path.join(fixture.projectRoot, 'a-dir'), { recursive: true });
      fs.rmSync(path.join(fixture.projectRoot, 'm.txt'));
      fs.rmSync(path.join(fixture.projectRoot, 'z-dir'), { recursive: true });
      fs.mkdirSync(path.join(fixture.projectRoot, 'a-dir'));
      fs.writeFileSync(path.join(fixture.projectRoot, 'm.txt'), 'middle', 'utf8');
      fs.mkdirSync(path.join(fixture.projectRoot, 'z-dir'));
      fs.writeFileSync(path.join(fixture.projectRoot, 'z-dir', 'a.txt'), 'alpha', 'utf8');
      fs.writeFileSync(path.join(fixture.projectRoot, 'z-dir', 'b.txt'), 'bravo', 'utf8');
      const second = context.snapshot();
      expect(second).toEqual(first);
      expect(first.map(entry => entry.reference)).toEqual([
        'a-dir',
        'm.txt',
        'z-dir',
        'z-dir/a.txt',
        'z-dir/b.txt'
      ]);
      expect(first.find(entry => entry.reference === 'z-dir/a.txt')?.sha256)
        .toBe(crypto.createHash('sha256').update('alpha').digest('hex'));
      expect(Object.isFrozen(first)).toBe(true);
      expect(first.every(Object.isFrozen)).toBe(true);
      expect(context.list().every(Object.isFrozen)).toBe(true);
      const detachedReadJson = context.readJson;
      expect(detachedReadJson('m.txt')).toBeNull();
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('canonicalizes project root passed through a symlink', () => {
    const fixture = createFixture();
    const rootLink = path.join(fixture.tempRoot, 'project-link');
    fs.symlinkSync(fixture.projectRoot, rootLink, 'dir');

    try {
      const context = createProjectReadContext(rootLink);
      expect(context.projectRoot).toBe(fs.realpathSync(fixture.projectRoot));
      expect(context.mdocsRoot).toBe(path.join(fs.realpathSync(fixture.projectRoot), 'mdocs'));
      expect(Object.isFrozen(context)).toBe(true);
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects a project root that is not a directory', () => {
    const fixture = createFixture();
    const file = path.join(fixture.tempRoot, 'not-a-directory');
    fs.writeFileSync(file, 'content', 'utf8');
    try {
      expect(() => createProjectReadContext(file)).toThrow('Project root is not a directory');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('allows contained symlinks and rejects escaping file and directory symlinks', () => {
    const fixture = createFixture();
    const contained = path.join(fixture.projectRoot, 'contained.txt');
    const outsideFile = path.join(fixture.outsideRoot, 'outside.txt');
    fs.writeFileSync(contained, 'contained', 'utf8');
    fs.writeFileSync(outsideFile, 'outside', 'utf8');
    fs.symlinkSync('contained.txt', path.join(fixture.projectRoot, 'contained-link.txt'), 'file');
    fs.symlinkSync(outsideFile, path.join(fixture.projectRoot, 'outside-link.txt'), 'file');
    fs.symlinkSync(fixture.outsideRoot, path.join(fixture.projectRoot, 'outside-dir'), 'dir');
    fs.symlinkSync(path.join(fixture.outsideRoot, 'missing.txt'),
      path.join(fixture.projectRoot, 'dangling-outside.txt'), 'file');

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      expect(context.resolve('contained-link.txt')).toBe(fs.realpathSync(contained));
      expect(context.readText('contained-link.txt')).toBe('contained');
      expect(context.exists('contained-link.txt')).toBe(true);
      expectContextError(() => context.resolve('outside-link.txt'), 'symlink-escape');
      expectContextError(() => context.readText('outside-link.txt'), 'symlink-escape');
      expectContextError(() => context.exists('outside-dir'), 'symlink-escape');
      expectContextError(() => context.list('outside-dir'), 'symlink-escape');
      expectContextError(() => context.resolve('outside-dir/missing.txt'), 'symlink-escape');
      expectContextError(() => context.resolve('dangling-outside.txt'), 'symlink-escape');
      expect(context.list().find(entry => entry.name === 'outside-dir')).toEqual({
        name: 'outside-dir',
        kind: 'symlink'
      });
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test.each([
    '',
    '   ',
    '/etc/passwd',
    '~/config',
    'C:\\Users\\config.json',
    'C:config.json',
    '../outside',
    'config/../../outside',
    'config\\..\\outside',
    'config/..\\outside'
  ])('rejects invalid lexical reference %p', reference => {
    const fixture = createFixture();
    try {
      const context = createProjectReadContext(fixture.projectRoot);
      expectContextError(() => context.resolve(reference), 'invalid-reference');
      expectContextError(() => context.exists(reference), 'invalid-reference');
      expectContextError(() => context.snapshot(reference), 'invalid-reference');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('missing, malformed JSON, and directory reads return null or false', () => {
    const fixture = createFixture();
    fs.mkdirSync(path.join(fixture.projectRoot, 'directory'));
    fs.writeFileSync(path.join(fixture.projectRoot, 'malformed.json'), '{nope', 'utf8');
    fs.writeFileSync(path.join(fixture.projectRoot, 'valid.json'), '{"nested":{"value":1}}', 'utf8');

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      expect(context.resolve('missing')).toBeNull();
      expect(context.exists('missing')).toBe(false);
      expect(context.readText('missing')).toBeNull();
      expect(context.readJson('malformed.json')).toBeNull();
      expect(context.readText('directory')).toBeNull();
      expect(context.readJson('directory')).toBeNull();
      expect(context.list('missing')).toEqual([]);
      expect(context.list('valid.json')).toEqual([]);
      const parsed = context.readJson('valid.json') as { nested: { value: number } };
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.nested)).toBe(true);
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('source has no mutable core, factory, hook, or writer construction dependency', () => {
    const root = path.join(__dirname, '../../src/agents/project-context.ts');
    const allowedBuiltins = new Set(['crypto', 'fs', 'path']);
    const visited = new Set<string>();
    const violations: string[] = [];

    const resolveLocal = (from: string, specifier: string): string | null => {
      const base = path.resolve(path.dirname(from), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
      return null;
    };
    const visit = (filename: string): void => {
      const canonical = fs.realpathSync(filename);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      const source = fs.readFileSync(canonical, 'utf8');
      const sourceFile = ts.createSourceFile(canonical, source, ts.ScriptTarget.Latest, true);

      const inspect = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          if (specifier.startsWith('.')) {
            violations.push(`${canonical}: local import ${specifier}`);
            const dependency = resolveLocal(canonical, specifier);
            if (dependency === null) violations.push(`${canonical}: unresolved import ${specifier}`);
            else visit(dependency);
          } else if (!allowedBuiltins.has(specifier)) {
            violations.push(`${canonical}: unapproved import ${specifier}`);
          }
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
          violations.push(`${canonical}: export-from`);
        } else if (ts.isImportEqualsDeclaration(node)) {
          violations.push(`${canonical}: import-equals`);
        } else if (ts.isCallExpression(node)) {
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            violations.push(`${canonical}: dynamic import`);
          } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
            violations.push(`${canonical}: require`);
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(sourceFile);
    };

    visit(root);
    expect(violations).toEqual([]);
    expect([...visited]).toEqual([fs.realpathSync(root)]);
  });

  test('fails closed when final component becomes an outside symlink before open', () => {
    const fixture = createFixture();
    const insideFile = path.join(fixture.projectRoot, 'evidence.txt');
    const outsideFile = path.join(fixture.outsideRoot, 'secret.txt');
    fs.writeFileSync(insideFile, 'inside', 'utf8');
    fs.writeFileSync(outsideFile, 'outside-secret', 'utf8');
    const canonicalInsideFile = fs.realpathSync(insideFile);
    const originalRealpath = fs.realpathSync.bind(fs);
    let swapped = false;
    const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation(((target: fs.PathLike) => {
      const resolved = originalRealpath(target);
      if (!swapped && path.resolve(String(target)) === canonicalInsideFile) {
        swapped = true;
        fs.unlinkSync(insideFile);
        fs.symlinkSync(outsideFile, insideFile, 'file');
      }
      return resolved;
    }) as typeof fs.realpathSync);
    const openSpy = jest.spyOn(fs, 'openSync');
    const readSpy = jest.spyOn(fs, 'readSync');

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      expectContextError(() => context.readText('evidence.txt'), 'symlink-escape');
      const attemptedFlags = openSpy.mock.calls
        .filter(call => call[0] === canonicalInsideFile)
        .map(call => call[1] as number);
      if ((fs.constants.O_NOFOLLOW ?? 0) !== 0) {
        expect(attemptedFlags.some(flags =>
          (flags & fs.constants.O_NOFOLLOW) === fs.constants.O_NOFOLLOW)).toBe(true);
      }
      expect(readSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside-secret');
    } finally {
      readSpy.mockRestore();
      openSpy.mockRestore();
      realpathSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects an opened fd whose pinned target is outside root', () => {
    const fixture = createFixture();
    const insideFile = path.join(fixture.projectRoot, 'evidence.txt');
    const outsideFile = path.join(fixture.outsideRoot, 'secret.txt');
    fs.writeFileSync(insideFile, 'inside', 'utf8');
    fs.writeFileSync(outsideFile, 'outside-secret', 'utf8');
    const canonicalInsideFile = fs.realpathSync(insideFile);
    const originalOpen = fs.openSync.bind(fs);
    const originalRealpath = fs.realpathSync.bind(fs);
    let redirectedFd: number | null = null;
    const openSpy = jest.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode) => {
      if (path.resolve(String(target)) === canonicalInsideFile) {
        redirectedFd = originalOpen(outsideFile, flags);
        return redirectedFd;
      }
      return originalOpen(target, flags);
    }) as typeof fs.openSync);
    const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation(((target: fs.PathLike) => {
      if (
        redirectedFd !== null &&
        [`/proc/self/fd/${redirectedFd}`, `/dev/fd/${redirectedFd}`].includes(String(target))
      ) {
        return outsideFile;
      }
      return originalRealpath(target);
    }) as typeof fs.realpathSync);
    const readSpy = jest.spyOn(fs, 'readSync');

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      expectContextError(() => context.readText('evidence.txt'), 'symlink-escape');
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      realpathSpy.mockRestore();
      openSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('proves containment before treating an opened non-directory as missing', () => {
    const fixture = createFixture();
    const outsideFile = path.join(fixture.outsideRoot, 'secret.txt');
    fs.writeFileSync(path.join(fixture.projectRoot, 'inside.txt'), 'inside', 'utf8');
    fs.writeFileSync(outsideFile, 'outside-secret', 'utf8');
    const context = createProjectReadContext(fixture.projectRoot);
    const originalOpen = fs.openSync.bind(fs);
    const originalRealpath = fs.realpathSync.bind(fs);
    let redirectedFd: number | null = null;
    const openSpy = jest.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode) => {
      if (path.resolve(String(target)) === context.projectRoot) {
        redirectedFd = originalOpen(outsideFile, Number(flags) & ~(fs.constants.O_DIRECTORY ?? 0));
        return redirectedFd;
      }
      return originalOpen(target, flags);
    }) as typeof fs.openSync);
    const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation(((target: fs.PathLike) => {
      if (
        redirectedFd !== null &&
        [`/proc/self/fd/${redirectedFd}`, `/dev/fd/${redirectedFd}`].includes(String(target))
      ) {
        return outsideFile;
      }
      return originalRealpath(target);
    }) as typeof fs.realpathSync);
    const opendirSpy = jest.spyOn(fs, 'opendirSync');

    try {
      expectContextError(() => context.list(), 'symlink-escape');
      expect(opendirSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside-secret');
    } finally {
      opendirSpy.mockRestore();
      realpathSpy.mockRestore();
      openSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects intermediate symlink race resolving to outside regular file', () => {
    const fixture = createFixture();
    const nested = path.join(fixture.projectRoot, 'nested');
    const insideTarget = path.join(nested, 'target');
    const outsideTarget = path.join(fixture.outsideRoot, 'target');
    fs.mkdirSync(nested);
    fs.mkdirSync(insideTarget);
    fs.writeFileSync(outsideTarget, 'outside-secret', 'utf8');
    const canonicalInsideTarget = fs.realpathSync(insideTarget);
    const context = createProjectReadContext(fixture.projectRoot);
    const originalRealpath = fs.realpathSync.bind(fs);
    let swapped = false;
    const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation(((target: fs.PathLike) => {
      const resolved = originalRealpath(target);
      if (!swapped && path.resolve(String(target)) === canonicalInsideTarget) {
        swapped = true;
        fs.renameSync(nested, path.join(fixture.projectRoot, 'nested-inside'));
        fs.symlinkSync(fixture.outsideRoot, nested, 'dir');
      }
      return resolved;
    }) as typeof fs.realpathSync);
    const openSpy = jest.spyOn(fs, 'openSync');

    try {
      expectContextError(() => context.list('nested/target'), 'symlink-escape');
      const flags = openSpy.mock.calls
        .filter(call => path.resolve(String(call[0])) === canonicalInsideTarget)
        .map(call => call[1] as number);
      if ((fs.constants.O_DIRECTORY ?? 0) !== 0) {
        expect(flags.some(value => (value & fs.constants.O_DIRECTORY) !== 0)).toBe(true);
        expect(flags.some(value => (value & fs.constants.O_DIRECTORY) === 0)).toBe(true);
      }
      expect(fs.readFileSync(outsideTarget, 'utf8')).toBe('outside-secret');
    } finally {
      openSpy.mockRestore();
      realpathSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects same-inode mutation during direct text read', () => {
    const fixture = createFixture();
    const file = path.join(fixture.projectRoot, 'evidence.txt');
    const content = Buffer.alloc(128 * 1024, 'a');
    fs.writeFileSync(file, content);
    const inode = fs.statSync(file).ino;
    const context = createProjectReadContext(fixture.projectRoot);
    const originalRead = fs.readSync.bind(fs);
    const originalFstat = fs.fstatSync.bind(fs);
    let mutated = false;
    const readSpy = jest.spyOn(fs, 'readSync').mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null
    ) => {
      const bytesRead = originalRead(fd, buffer, offset, length, position);
      if (bytesRead > 0 && !mutated) {
        mutated = true;
        fs.writeFileSync(file, Buffer.alloc(content.byteLength, 'b'));
      }
      return bytesRead;
    }) as typeof fs.readSync);
    const fstatSpy = jest.spyOn(fs, 'fstatSync').mockImplementation(((
      fd: number,
      options?: fs.StatSyncOptions
    ) => {
      const stats = originalFstat(fd, options as never);
      if (mutated && typeof options === 'object' && options.bigint === true) {
        return new Proxy(stats as unknown as fs.BigIntStats, {
          get(value, property, receiver) {
            if (property === 'ctimeNs') return value.ctimeNs + 1n;
            return Reflect.get(value, property, receiver);
          }
        });
      }
      return stats;
    }) as typeof fs.fstatSync);

    try {
      expectContextError(() => context.readText('evidence.txt'), 'concurrent-mutation');
      expect(mutated).toBe(true);
      expect(fs.statSync(file).ino).toBe(inode);
    } finally {
      fstatSpy.mockRestore();
      readSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('enforces entry, aggregate byte, and file byte limits', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.projectRoot, 'a.txt'), '1234', 'utf8');
    fs.writeFileSync(path.join(fixture.projectRoot, 'b.txt'), '5678', 'utf8');

    try {
      expectContextError(
        () => createProjectReadContext(fixture.projectRoot, { maxEntries: 1 }).snapshot(),
        'limit-exceeded'
      );
      expectContextError(
        () => createProjectReadContext(fixture.projectRoot, { maxTotalBytes: 7 }).snapshot(),
        'limit-exceeded'
      );
      const fileLimited = createProjectReadContext(fixture.projectRoot, { maxFileBytes: 3 });
      expectContextError(() => fileLimited.readText('a.txt'), 'limit-exceeded');
      expectContextError(() => fileLimited.snapshot(), 'limit-exceeded');
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects invalid read limits', () => {
    const fixture = createFixture();
    try {
      expect(() => createProjectReadContext(fixture.projectRoot, { maxEntries: -1 }))
        .toThrow(RangeError);
      expect(() => createProjectReadContext(fixture.projectRoot, { maxTotalBytes: 1.5 }))
        .toThrow(RangeError);
      expect(() => createProjectReadContext(fixture.projectRoot, {
        maxFileBytes: Number.MAX_SAFE_INTEGER + 1
      })).toThrow(RangeError);
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('uses bigint stats for every fd identity comparison', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.projectRoot, 'file.txt'), 'content', 'utf8');
    const fstatSpy = jest.spyOn(fs, 'fstatSync');
    const statSpy = jest.spyOn(fs, 'statSync');

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      context.readText('file.txt');
      context.list();
      context.snapshot();
      expect(fstatSpy.mock.calls.length).toBeGreaterThan(0);
      expect(fstatSpy.mock.calls.every(call =>
        typeof call[1] === 'object' && call[1]?.bigint === true)).toBe(true);
      const identityStats = statSpy.mock.calls.filter(call => typeof call[1] === 'object');
      expect(identityStats.length).toBeGreaterThan(0);
      expect(identityStats.every(call => call[1]?.bigint === true)).toBe(true);
    } finally {
      statSpy.mockRestore();
      fstatSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('classifies non-file filesystem objects without consuming content', () => {
    const fixture = createFixture();
    const target = path.join(fixture.projectRoot, 'special');
    fs.writeFileSync(target, '', 'utf8');
    const context = createProjectReadContext(fixture.projectRoot);
    const originalLstat = fs.lstatSync.bind(fs);
    const lstatSpy = jest.spyOn(fs, 'lstatSync').mockImplementation(((
      value: fs.PathLike,
      options?: fs.StatSyncOptions
    ) => {
      const stats = originalLstat(value, options as never);
      if (
        path.basename(String(value)) === 'special' &&
        typeof options === 'object' &&
        options.bigint === true
      ) {
        return new Proxy(stats as fs.BigIntStats, {
          get(current, property, receiver) {
            if (property === 'isFile' || property === 'isDirectory' || property === 'isSymbolicLink') {
              return () => false;
            }
            return Reflect.get(current, property, receiver);
          }
        });
      }
      return stats;
    }) as typeof fs.lstatSync);

    try {
      expect(context.list()).toEqual([{ name: 'special', kind: 'other' }]);
      expect(context.snapshot('special')).toEqual([{
        reference: 'special',
        kind: 'other',
        size: 0
      }]);
    } finally {
      lstatSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('propagates generic file I/O errors without relabeling them as escapes', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.projectRoot, 'file.txt'), 'content', 'utf8');
    const context = createProjectReadContext(fixture.projectRoot);
    const ioError = Object.assign(new Error('read failed'), { code: 'EIO' });
    const readSpy = jest.spyOn(fs, 'readSync').mockImplementation(() => {
      throw ioError;
    });

    try {
      expect(() => context.readText('file.txt')).toThrow(ioError);
    } finally {
      readSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('propagates generic open and fstat errors unchanged', () => {
    const fixture = createFixture();
    const file = path.join(fixture.projectRoot, 'file.txt');
    fs.writeFileSync(file, 'content', 'utf8');
    const context = createProjectReadContext(fixture.projectRoot);
    const canonicalFile = fs.realpathSync(file);
    const originalOpen = fs.openSync.bind(fs);
    const accessError = Object.assign(new Error('denied'), { code: 'EACCES' });
    const openSpy = jest.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode) => {
      if (path.resolve(String(target)) === canonicalFile) throw accessError;
      return originalOpen(target, flags);
    }) as typeof fs.openSync);

    try {
      expect(() => context.readText('file.txt')).toThrow(accessError);
    } finally {
      openSpy.mockRestore();
    }

    const statError = Object.assign(new Error('fstat failed'), { code: 'EIO' });
    const fstatSpy = jest.spyOn(fs, 'fstatSync').mockImplementation(() => {
      throw statError;
    });
    try {
      expect(() => context.readText('file.txt')).toThrow(statError);
    } finally {
      fstatSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('retries without optional flags only when the platform rejects them', () => {
    const fixture = createFixture();
    const file = path.join(fixture.projectRoot, 'file.txt');
    fs.writeFileSync(file, 'content', 'utf8');
    const context = createProjectReadContext(fixture.projectRoot);
    const canonicalFile = fs.realpathSync(file);
    const originalOpen = fs.openSync.bind(fs);
    const unsupported = Object.assign(new Error('unsupported flags'), { code: 'EINVAL' });
    let rejected = false;
    const openSpy = jest.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode) => {
      if (!rejected && path.resolve(String(target)) === canonicalFile) {
        rejected = true;
        throw unsupported;
      }
      return originalOpen(target, flags);
    }) as typeof fs.openSync);

    try {
      expect(context.readText('file.txt')).toBe('content');
      expect(rejected).toBe(true);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('propagates generic realpath errors unchanged', () => {
    const fixture = createFixture();
    const context = createProjectReadContext(fixture.projectRoot);
    const target = path.join(context.projectRoot, 'blocked');
    const realpathError = Object.assign(new Error('realpath denied'), { code: 'EACCES' });
    const originalRealpath = fs.realpathSync.bind(fs);
    const realpathSpy = jest.spyOn(fs, 'realpathSync').mockImplementation(((value: fs.PathLike) => {
      if (path.resolve(String(value)) === target) throw realpathError;
      return originalRealpath(value);
    }) as typeof fs.realpathSync);

    try {
      expect(() => context.resolve('blocked')).toThrow(realpathError);
    } finally {
      realpathSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('fails after a directory vanishes twice before enumeration', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.projectRoot, 'file.txt'), 'content', 'utf8');
    const context = createProjectReadContext(fixture.projectRoot);
    const missing = Object.assign(new Error('directory missing'), { code: 'ENOENT' });
    const opendirSpy = jest.spyOn(fs, 'opendirSync').mockImplementation(() => {
      throw missing;
    });

    try {
      expectContextError(() => context.list(), 'concurrent-mutation');
      expect(opendirSpy).toHaveBeenCalledTimes(2);
    } finally {
      opendirSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('returns missing when a file vanishes before its fd opens', () => {
    const fixture = createFixture();
    const file = path.join(fixture.projectRoot, 'file.txt');
    fs.writeFileSync(file, 'content', 'utf8');
    const context = createProjectReadContext(fixture.projectRoot);
    const canonicalFile = fs.realpathSync(file);
    const originalOpen = fs.openSync.bind(fs);
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const openSpy = jest.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode) => {
      if (path.resolve(String(target)) === canonicalFile) throw missing;
      return originalOpen(target, flags);
    }) as typeof fs.openSync);

    try {
      expect(context.readText('file.txt')).toBeNull();
    } finally {
      openSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('retries one directory generation change then fails without mixed entries', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.projectRoot, 'inside.txt'), 'inside', 'utf8');
    fs.writeFileSync(path.join(fixture.outsideRoot, 'secret.txt'), 'outside-secret', 'utf8');
    const context = createProjectReadContext(fixture.projectRoot);
    const canonicalRoot = context.projectRoot;
    const originalStat = fs.statSync.bind(fs);
    let generationReads = 0;
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(((
      target: fs.PathLike,
      options?: fs.StatSyncOptions
    ) => {
      const stats = originalStat(target, options as never);
      if (
        path.resolve(String(target)) === canonicalRoot &&
        typeof options === 'object' &&
        options.bigint === true
      ) {
        generationReads += 1;
        if (generationReads % 2 === 1) {
          return new Proxy(stats as fs.BigIntStats, {
            get(value, property, receiver) {
              if (property === 'ctimeNs') return value.ctimeNs + 1n;
              return Reflect.get(value, property, receiver);
            }
          });
        }
      }
      return stats;
    }) as typeof fs.statSync);
    const opendirSpy = jest.spyOn(fs, 'opendirSync');

    try {
      expectContextError(() => context.list(), 'concurrent-mutation');
      expect(opendirSpy).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(path.join(fixture.outsideRoot, 'secret.txt'), 'utf8'))
        .toBe('outside-secret');
    } finally {
      opendirSpy.mockRestore();
      statSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('returns only stable entries after one directory generation retry', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.projectRoot, 'stable.txt'), 'stable', 'utf8');
    const context = createProjectReadContext(fixture.projectRoot);
    const canonicalRoot = context.projectRoot;
    const originalStat = fs.statSync.bind(fs);
    let openedDirectories = 0;
    let firstDirectoryClosed = false;
    let injectedChange = false;
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(((
      target: fs.PathLike,
      options?: fs.StatSyncOptions
    ) => {
      const stats = originalStat(target, options as never);
      if (
        firstDirectoryClosed &&
        !injectedChange &&
        path.resolve(String(target)) === canonicalRoot &&
        typeof options === 'object' &&
        options.bigint === true
      ) {
        injectedChange = true;
        return new Proxy(stats as fs.BigIntStats, {
          get(value, property, receiver) {
            if (property === 'ctimeNs') return value.ctimeNs + 1n;
            return Reflect.get(value, property, receiver);
          }
        });
      }
      return stats;
    }) as typeof fs.statSync);
    const originalOpendir = fs.opendirSync.bind(fs);
    const opendirSpy = jest.spyOn(fs, 'opendirSync').mockImplementation(((target: fs.PathLike) => {
      openedDirectories += 1;
      const directory = originalOpendir(target);
      if (openedDirectories === 1) {
        const originalClose = directory.closeSync.bind(directory);
        directory.closeSync = () => {
          originalClose();
          firstDirectoryClosed = true;
        };
      }
      return directory;
    }) as typeof fs.opendirSync);

    try {
      expect(context.list()).toEqual([{ name: 'stable.txt', kind: 'file' }]);
      expect(opendirSpy).toHaveBeenCalledTimes(2);
    } finally {
      opendirSpy.mockRestore();
      statSpy.mockRestore();
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('hashes raw symlink target bytes', () => {
    if (process.platform === 'win32') return;
    const fixture = createFixture();
    const target = Buffer.from([0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0xff]);
    const link = path.join(fixture.projectRoot, 'raw-link');
    fs.symlinkSync(target, Buffer.from(link));

    try {
      const entry = createProjectReadContext(fixture.projectRoot).snapshot('raw-link')[0];
      expect(entry).toEqual({
        reference: 'raw-link',
        kind: 'symlink',
        size: target.byteLength,
        sha256: crypto.createHash('sha256').update(target).digest('hex')
      });
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('snapshot records outside symlink target text without following outside content', () => {
    const fixture = createFixture();
    const outsideFile = path.join(fixture.outsideRoot, 'secret.txt');
    const outsideContent = 'outside-secret-content';
    fs.writeFileSync(outsideFile, outsideContent, 'utf8');
    fs.symlinkSync(outsideFile, path.join(fixture.projectRoot, 'secret-link'), 'file');

    try {
      const context = createProjectReadContext(fixture.projectRoot);
      const snapshot = context.snapshot();
      const link = snapshot.find(entry => entry.reference === 'secret-link');
      expect(link).toEqual({
        reference: 'secret-link',
        kind: 'symlink',
        size: Buffer.byteLength(outsideFile),
        sha256: crypto.createHash('sha256').update(outsideFile).digest('hex')
      });
      expect(snapshot.some(entry => entry.sha256 ===
        crypto.createHash('sha256').update(outsideContent).digest('hex'))).toBe(false);
    } finally {
      fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });
});
