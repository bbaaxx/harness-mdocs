# Surface-Neutral Mdocs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `harness-mdocs` as a single TypeScript package that preserves the current `opencode-mdocs` behavior while adding a Codex v1 surface.

**Architecture:** Use one npm package with a strict internal split: `src/core/**` owns mdocs behavior, command semantics, storage, validation, workflow, search, audit, and dispatch; `src/surfaces/**` owns harness translation only. Start with opencode parity as the regression baseline, then add Codex v1 packaging and CLI command access through the same core command registry.

**Tech Stack:** Node >= 18, TypeScript, Jest, zod, Codex plugin manifest/skills, opencode plugin runtime compatibility.

---

## Source Material

- Spec source: `surface-expansion/README.md`
- Core behavior spec: `surface-expansion/02-core-package.md`
- Adapter contract spec: `surface-expansion/03-surface-adapter-contract.md`
- Codex v1 spec: `surface-expansion/04-codex-v1-surface.md`
- Opencode parity spec: `surface-expansion/05-opencode-parity-surface.md`
- Migration and verification spec: `surface-expansion/06-migration-and-verification.md`
- Reference implementation: `opencode-mdocs/`

## File Structure

Create the package in `harness-mdocs/`:

```text
harness-mdocs/
  package.json
  tsconfig.json
  jest.config.js
  README.md
  src/
    index.ts
    api.ts
    core/
      index.ts
      factory.ts
      types.ts
      managers/
        mdocs.ts
        initiative.ts
        wiki.ts
      workflow/
        engine.ts
      validation/
        linter.ts
      search.ts
      audit.ts
      subagent.ts
      lifecycle.ts
      commands/
        registry.ts
        schemas.ts
        utils.ts
    surfaces/
      opencode/
        index.ts
        opencode.ts
        adapter.ts
        config.ts
        hooks.ts
        tools.ts
        result.ts
      codex/
        index.ts
        cli.ts
        plugin/
          .codex-plugin/plugin.json
          skills/mdocs-workflow/SKILL.md
          skills/mdocs-initiative/SKILL.md
          skills/mdocs-orchestrator/SKILL.md
    cli/
      index.ts
  prompts/
    mdocs-workflow.md
    mdocs-initiative.md
    mdocs-orchestrator.md
  templates/
    initiative.md
    wiki-entry.md
  tests/
    core/
    surfaces/
      opencode/
      codex/
    fixtures/
```

Boundary rules:

- `src/core/**` must not import from `src/surfaces/**`, `src/cli/**`, or any harness SDK.
- `src/surfaces/opencode/**` may import `src/core/**` and opencode-specific peer types.
- `src/surfaces/codex/**` may import `src/core/**` and Codex plugin assets.
- `src/cli/**` may import `src/core/**` only.
- Command behavior lives in `src/core/commands/registry.ts`; surfaces call it instead of duplicating command logic.

---

### Task 1: Scaffold The Single-Package TypeScript Project

**Files:**
- Create: `harness-mdocs/package.json`
- Create: `harness-mdocs/tsconfig.json`
- Create: `harness-mdocs/jest.config.js`
- Create: `harness-mdocs/src/index.ts`
- Create: `harness-mdocs/src/api.ts`
- Create: `harness-mdocs/README.md`

- [ ] **Step 1: Create the package manifest**

Write `harness-mdocs/package.json`:

```json
{
  "name": "harness-mdocs",
  "version": "0.1.0",
  "description": "Surface-neutral initiative and wiki memory for AI coding harnesses.",
  "license": "MIT",
  "author": "bbaaxx",
  "keywords": [
    "mdocs",
    "memory",
    "workflow",
    "initiative",
    "wiki",
    "codex",
    "opencode"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "mdocs": "dist/cli/index.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./api": {
      "types": "./dist/api.d.ts",
      "default": "./dist/api.js"
    },
    "./core": {
      "types": "./dist/core/index.d.ts",
      "default": "./dist/core/index.js"
    },
    "./opencode": {
      "types": "./dist/surfaces/opencode/index.d.ts",
      "default": "./dist/surfaces/opencode/index.js"
    },
    "./codex": {
      "types": "./dist/surfaces/codex/index.d.ts",
      "default": "./dist/surfaces/codex/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "clean": "rimraf dist",
    "test": "jest",
    "test:core": "jest tests/core",
    "test:opencode": "jest tests/surfaces/opencode",
    "test:codex": "jest tests/surfaces/codex",
    "prepack": "npm run build"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "^1.0.0"
  },
  "peerDependenciesMeta": {
    "@opencode-ai/plugin": {
      "optional": true
    }
  },
  "dependencies": {
    "zod": "^4.1.8"
  },
  "devDependencies": {
    "@types/jest": "^30.0.0",
    "@types/node": "^20.0.0",
    "jest": "^29.0.0",
    "rimraf": "^6.0.1",
    "ts-jest": "^29.0.0",
    "typescript": "^5.0.0"
  },
  "files": [
    "dist",
    "prompts",
    "templates",
    "src/surfaces/codex/plugin",
    "README.md",
    "LICENSE"
  ]
}
```

- [ ] **Step 2: Create TypeScript config**

Write `harness-mdocs/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 3: Create Jest config**

Write `harness-mdocs/jest.config.js`:

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  clearMocks: true
};
```

- [ ] **Step 4: Create placeholder exports that compile**

Write `harness-mdocs/src/index.ts`:

```ts
export * from './api';
```

Write `harness-mdocs/src/api.ts`:

```ts
export {};
```

- [ ] **Step 5: Create package README**

Write `harness-mdocs/README.md`:

```md
# harness-mdocs

Surface-neutral mdocs for AI coding harnesses.

The package exposes a shared core plus harness adapters. Core owns initiative/wiki storage, workflow state, validation, search, audit, and command behavior. Surfaces translate the core into a host integration such as opencode or Codex.
```

- [ ] **Step 6: Install dependencies**

Run from `harness-mdocs/`:

```bash
npm install
```

Expected: `package-lock.json` is created and dependencies install without errors.

- [ ] **Step 7: Verify scaffold builds**

Run from `harness-mdocs/`:

```bash
npm run build
```

Expected: TypeScript exits successfully and creates `dist/`.

- [ ] **Step 8: Commit scaffold**

```bash
git add harness-mdocs
git commit -m "chore: scaffold harness-mdocs package"
```

If the repository root is intentionally not a git repository, skip the commit step and record that in the task notes.

---

### Task 2: Move Current Core Managers Into `src/core`

**Files:**
- Create: `harness-mdocs/src/core/types.ts`
- Create: `harness-mdocs/src/core/managers/mdocs.ts`
- Create: `harness-mdocs/src/core/managers/initiative.ts`
- Create: `harness-mdocs/src/core/managers/wiki.ts`
- Create: `harness-mdocs/src/core/workflow/engine.ts`
- Create: `harness-mdocs/src/core/search.ts`
- Create: `harness-mdocs/src/core/audit.ts`
- Create: `harness-mdocs/src/core/validation/linter.ts`
- Create: `harness-mdocs/src/core/subagent.ts`
- Create: `harness-mdocs/src/core/index.ts`
- Test: `harness-mdocs/tests/core/manager-imports.test.ts`

- [ ] **Step 1: Copy source modules**

Copy these reference files into the matching `harness-mdocs/src/core` locations:

```text
opencode-mdocs/src/types.ts      -> harness-mdocs/src/core/types.ts
opencode-mdocs/src/mdocs.ts      -> harness-mdocs/src/core/managers/mdocs.ts
opencode-mdocs/src/initiative.ts -> harness-mdocs/src/core/managers/initiative.ts
opencode-mdocs/src/wiki.ts       -> harness-mdocs/src/core/managers/wiki.ts
opencode-mdocs/src/workflow.ts   -> harness-mdocs/src/core/workflow/engine.ts
opencode-mdocs/src/search.ts     -> harness-mdocs/src/core/search.ts
opencode-mdocs/src/audit.ts      -> harness-mdocs/src/core/audit.ts
opencode-mdocs/src/linter.ts     -> harness-mdocs/src/core/validation/linter.ts
opencode-mdocs/src/subagent.ts   -> harness-mdocs/src/core/subagent.ts
```

Adjust relative imports:

```ts
// Before in initiative.ts
import { Initiative, PlanItem, PlanItemStatus, parseFrontmatter } from './types';

// After in src/core/managers/initiative.ts
import { Initiative, PlanItemStatus, parseFrontmatter } from '../types';
```

Use the same pattern for every moved file.

- [ ] **Step 2: Create core export barrel**

Write `harness-mdocs/src/core/index.ts`:

```ts
export * from './types';
export * from './managers/mdocs';
export * from './managers/initiative';
export * from './managers/wiki';
export * from './workflow/engine';
export * from './search';
export * from './audit';
export * from './validation/linter';
export * from './subagent';
```

- [ ] **Step 3: Update public API exports**

Write `harness-mdocs/src/api.ts`:

```ts
export * from './core';
```

- [ ] **Step 4: Add import smoke test**

Write `harness-mdocs/tests/core/manager-imports.test.ts`:

```ts
import {
  AuditLog,
  InitiativeManager,
  MdocsLinter,
  MdocsManager,
  SearchEngine,
  SubagentAssembler,
  WikiManager,
  WorkflowEngine
} from '../../src/core';

test('core managers are exported from the core barrel', () => {
  expect(MdocsManager).toBeDefined();
  expect(InitiativeManager).toBeDefined();
  expect(WikiManager).toBeDefined();
  expect(WorkflowEngine).toBeDefined();
  expect(SearchEngine).toBeDefined();
  expect(AuditLog).toBeDefined();
  expect(MdocsLinter).toBeDefined();
  expect(SubagentAssembler).toBeDefined();
});
```

- [ ] **Step 5: Run import test**

Run from `harness-mdocs/`:

```bash
npm test -- tests/core/manager-imports.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit moved core managers**

```bash
git add harness-mdocs/src harness-mdocs/tests
git commit -m "feat: move mdocs managers into core"
```

---

### Task 3: Port Core Behavior Tests

**Files:**
- Create: `harness-mdocs/tests/core/mdocs.test.ts`
- Create: `harness-mdocs/tests/core/initiative.test.ts`
- Create: `harness-mdocs/tests/core/wiki.test.ts`
- Create: `harness-mdocs/tests/core/workflow.test.ts`
- Create: `harness-mdocs/tests/core/search.test.ts`
- Create: `harness-mdocs/tests/core/audit.test.ts`
- Create: `harness-mdocs/tests/core/linter.test.ts`
- Create: `harness-mdocs/tests/core/subagent.test.ts`

- [ ] **Step 1: Copy reference tests**

Copy these tests and adjust imports from `../../src/<module>` to `../../src/core/<path>`:

```text
opencode-mdocs/src/__tests__/mdocs.test.ts      -> harness-mdocs/tests/core/mdocs.test.ts
opencode-mdocs/src/__tests__/initiative.test.ts -> harness-mdocs/tests/core/initiative.test.ts
opencode-mdocs/src/__tests__/wiki.test.ts       -> harness-mdocs/tests/core/wiki.test.ts
opencode-mdocs/src/__tests__/workflow.test.ts   -> harness-mdocs/tests/core/workflow.test.ts
opencode-mdocs/src/__tests__/search.test.ts     -> harness-mdocs/tests/core/search.test.ts
opencode-mdocs/src/__tests__/audit.test.ts      -> harness-mdocs/tests/core/audit.test.ts
opencode-mdocs/src/__tests__/linter.test.ts     -> harness-mdocs/tests/core/linter.test.ts
opencode-mdocs/src/__tests__/subagent.test.ts   -> harness-mdocs/tests/core/subagent.test.ts
```

Example import rewrite:

```ts
// Before
import { InitiativeManager } from '../initiative';

// After
import { InitiativeManager } from '../../src/core/managers/initiative';
```

- [ ] **Step 2: Run core tests**

Run from `harness-mdocs/`:

```bash
npm run test:core
```

Expected: all copied core tests pass. Failures caused by import paths are fixed in the test files or moved source imports, not by changing behavior.

- [ ] **Step 3: Commit core tests**

```bash
git add harness-mdocs/tests/core harness-mdocs/src/core
git commit -m "test: port core behavior tests"
```

---

### Task 4: Add `createMdocsCore` Factory And Lifecycle Service

**Files:**
- Create: `harness-mdocs/src/core/factory.ts`
- Create: `harness-mdocs/src/core/lifecycle.ts`
- Modify: `harness-mdocs/src/core/index.ts`
- Test: `harness-mdocs/tests/core/factory.test.ts`

- [ ] **Step 1: Write failing factory test**

Write `harness-mdocs/tests/core/factory.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-core-'));
}

describe('createMdocsCore', () => {
  test('creates managers rooted under the configured mdocs directory', () => {
    const projectDir = tempProject();
    const core = createMdocsCore(projectDir);

    expect(core.projectDir).toBe(projectDir);
    expect(core.mdocsRoot).toBe(path.join(projectDir, 'mdocs'));
    expect(core.managers.mdocs).toBeDefined();
    expect(core.managers.initiatives).toBeDefined();
    expect(core.managers.wiki).toBeDefined();
    expect(core.managers.workflow).toBeDefined();
    expect(core.managers.search).toBeDefined();
    expect(core.managers.audit).toBeDefined();
    expect(core.managers.linter).toBeDefined();
    expect(core.managers.dispatch).toBeDefined();
    expect(core.lifecycle).toBeDefined();
  });

  test('initializes mdocs and bootstrap initiative only when missing', () => {
    const projectDir = tempProject();
    const core = createMdocsCore(projectDir);

    const first = core.lifecycle.ensureInitialized();
    const second = core.lifecycle.ensureInitialized();

    expect(first.initialized).toBe(true);
    expect(first.bootstrapInitiativeCreated).toBe(true);
    expect(second.initialized).toBe(false);
    expect(second.bootstrapInitiativeCreated).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'mdocs', 'initiatives', 'INDEX.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'mdocs', 'wiki', 'INDEX.md'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `harness-mdocs/`:

```bash
npm test -- tests/core/factory.test.ts
```

Expected: FAIL because `createMdocsCore` is not exported.

- [ ] **Step 3: Implement lifecycle service**

Write `harness-mdocs/src/core/lifecycle.ts`:

```ts
import { InitiativeManager } from './managers/initiative';
import { MdocsManager } from './managers/mdocs';

export interface MdocsLifecycleOptions {
  createInstallInitiative?: boolean;
  installInitiativeTitle?: string;
  installInitiativeId?: string;
  owner?: string;
  tags?: string[];
}

export interface MdocsLifecycleResult {
  initialized: boolean;
  bootstrapInitiativeCreated: boolean;
}

export class MdocsLifecycleService {
  constructor(
    private readonly mdocs: MdocsManager,
    private readonly initiatives: InitiativeManager,
    private readonly options: MdocsLifecycleOptions = {}
  ) {}

  ensureInitialized(): MdocsLifecycleResult {
    if (this.mdocs.exists()) {
      return { initialized: false, bootstrapInitiativeCreated: false };
    }

    const date = new Date().toISOString().split('T')[0];
    this.mdocs.init();

    if (this.options.createInstallInitiative === false) {
      return { initialized: true, bootstrapInitiativeCreated: false };
    }

    this.initiatives.create({
      id: this.options.installInitiativeId || 'install-mdocs',
      title: this.options.installInitiativeTitle || 'Install and Configure mdocs',
      status: 'active',
      created: date,
      updated: date,
      owner: this.options.owner || 'system',
      tags: this.options.tags || ['setup', 'plugin'],
      relatedWiki: [],
      objective: 'Install and configure mdocs for this project',
      plan: [
        { description: 'Install package', status: 'pending' },
        { description: 'Configure harness adapter', status: 'pending' },
        { description: 'Verify workflow', status: 'pending' }
      ],
      progressLog: ['Mdocs initialized'],
      artifacts: []
    });

    return { initialized: true, bootstrapInitiativeCreated: true };
  }
}
```

- [ ] **Step 4: Implement factory**

Write `harness-mdocs/src/core/factory.ts`:

```ts
import * as path from 'path';
import { AuditLog } from './audit';
import { MdocsLifecycleOptions, MdocsLifecycleService } from './lifecycle';
import { InitiativeManager } from './managers/initiative';
import { MdocsManager } from './managers/mdocs';
import { WikiManager, WikiManagerOptions } from './managers/wiki';
import { MdocsLinter } from './validation/linter';
import { SearchEngine } from './search';
import { SubagentAssembler } from './subagent';
import { WorkflowEngine } from './workflow/engine';

export interface MdocsCoreOptions {
  mdocsDirName?: string;
  standaloneCategories?: string[];
  wiki?: WikiManagerOptions;
  bootstrap?: MdocsLifecycleOptions;
}

export interface MdocsCore {
  projectDir: string;
  mdocsRoot: string;
  managers: {
    mdocs: MdocsManager;
    initiatives: InitiativeManager;
    wiki: WikiManager;
    workflow: WorkflowEngine;
    search: SearchEngine;
    audit: AuditLog;
    linter: MdocsLinter;
    dispatch: SubagentAssembler;
  };
  lifecycle: MdocsLifecycleService;
}

export function createMdocsCore(projectDir: string, options: MdocsCoreOptions = {}): MdocsCore {
  const mdocsRoot = path.join(projectDir, options.mdocsDirName || 'mdocs');
  const mdocs = new MdocsManager(mdocsRoot);
  const initiatives = new InitiativeManager(mdocsRoot);
  const wiki = new WikiManager(mdocsRoot, {
    standaloneCategories: options.wiki?.standaloneCategories ?? options.standaloneCategories
  });
  const workflow = new WorkflowEngine(mdocsRoot);
  const search = new SearchEngine(mdocsRoot);
  const audit = new AuditLog(mdocsRoot);
  const linter = new MdocsLinter(mdocsRoot);
  const dispatch = new SubagentAssembler();
  const lifecycle = new MdocsLifecycleService(mdocs, initiatives, options.bootstrap);

  return {
    projectDir,
    mdocsRoot,
    managers: { mdocs, initiatives, wiki, workflow, search, audit, linter, dispatch },
    lifecycle
  };
}
```

- [ ] **Step 5: Export factory and lifecycle**

Update `harness-mdocs/src/core/index.ts`:

```ts
export * from './types';
export * from './factory';
export * from './lifecycle';
export * from './managers/mdocs';
export * from './managers/initiative';
export * from './managers/wiki';
export * from './workflow/engine';
export * from './search';
export * from './audit';
export * from './validation/linter';
export * from './subagent';
```

- [ ] **Step 6: Run factory tests**

Run from `harness-mdocs/`:

```bash
npm test -- tests/core/factory.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit factory**

```bash
git add harness-mdocs/src/core harness-mdocs/tests/core/factory.test.ts
git commit -m "feat: add mdocs core factory"
```

---

### Task 5: Extract Core Command Registry

**Files:**
- Create: `harness-mdocs/src/core/commands/utils.ts`
- Create: `harness-mdocs/src/core/commands/registry.ts`
- Modify: `harness-mdocs/src/core/factory.ts`
- Modify: `harness-mdocs/src/core/index.ts`
- Test: `harness-mdocs/tests/core/commands.test.ts`

- [ ] **Step 1: Write failing command registry test**

Write `harness-mdocs/tests/core/commands.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-commands-'));
}

describe('MdocsCommandRegistry', () => {
  test('runs aggregate initiative.create through core commands', async () => {
    const projectDir = tempProject();
    const core = createMdocsCore(projectDir);
    core.lifecycle.ensureInitialized();

    const result = await core.commands.execute('initiative.create', {
      id: 'cmd-created',
      title: 'Command Created',
      owner: 'agent',
      tags: ['commands'],
      relatedWiki: [],
      objective: 'Create from core command registry',
      plan: ['Write test', { description: 'Implement registry', status: 'done' }]
    });

    const today = new Date().toISOString().split('T')[0];
    expect(result).toEqual({ success: true, filename: `cmd-created--${today}.md`, id: 'cmd-created' });
    expect(fs.existsSync(path.join(projectDir, 'mdocs', 'initiatives', `cmd-created--${today}.md`))).toBe(true);
  });

  test('returns supported commands for unsupported command names', async () => {
    const projectDir = tempProject();
    const core = createMdocsCore(projectDir);

    const result = await core.commands.execute('missing.command', {});

    expect(result).toMatchObject({
      error: 'Unsupported mdocs command: missing.command'
    });
    expect(result.supportedCommands).toContain('initiative.create');
    expect(result.supportedCommands).toContain('wiki.create');
    expect(result.supportedCommands).toContain('index.sync');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `harness-mdocs/`:

```bash
npm test -- tests/core/commands.test.ts
```

Expected: FAIL because `core.commands` does not exist.

- [ ] **Step 3: Add command utilities**

Write `harness-mdocs/src/core/commands/utils.ts`:

```ts
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
```

- [ ] **Step 4: Implement initial registry with all aggregate commands from reference plugin**

Write `harness-mdocs/src/core/commands/registry.ts` by moving the aggregate `mdocs` command branches from `opencode-mdocs/src/plugin.ts` into methods on this class:

```ts
import * as path from 'path';
import { AuditLog } from '../audit';
import { InitiativeManager } from '../managers/initiative';
import { MdocsManager } from '../managers/mdocs';
import { WikiManager } from '../managers/wiki';
import { MdocsLinter } from '../validation/linter';
import { SearchEngine } from '../search';
import { SubagentAssembler } from '../subagent';
import { WorkflowEngine } from '../workflow/engine';
import { findInitiativeFilename, slugify, today } from './utils';

export interface MdocsCommandContext {
  mdocsRoot: string;
  mdocs: MdocsManager;
  initiatives: InitiativeManager;
  wiki: WikiManager;
  workflow: WorkflowEngine;
  search: SearchEngine;
  audit: AuditLog;
  linter: MdocsLinter;
  dispatch: SubagentAssembler;
}

export class MdocsCommandRegistry {
  readonly supportedCommands = [
    'initiative.create',
    'initiative.update',
    'initiative.done',
    'initiative.delete',
    'initiative.archive',
    'wiki.create',
    'wiki.update',
    'wiki.stub',
    'wiki.delete',
    'wiki.list',
    'wiki.link',
    'wiki.xref',
    'validate',
    'index.sync'
  ];

  constructor(private readonly context: MdocsCommandContext) {}

  async execute(command: string, args: Record<string, any> = {}): Promise<any> {
    try {
      switch (command) {
        case 'initiative.create':
          return this.createInitiative(args);
        case 'initiative.update':
          return this.updateInitiative(args);
        case 'initiative.done':
          return this.doneInitiative(args);
        case 'initiative.delete':
          return this.deleteInitiative(args);
        case 'initiative.archive':
          return this.archiveInitiative(args);
        case 'wiki.create':
          return this.createWiki(args);
        case 'wiki.update':
          return this.updateWiki(args);
        case 'wiki.stub':
          return this.stubWiki(args);
        case 'wiki.delete':
          return this.deleteWiki(args);
        case 'wiki.list':
          return this.listWiki(args);
        case 'wiki.link':
          return this.linkWiki(args);
        case 'wiki.xref':
          return this.crossReferenceWiki(args);
        case 'validate':
          return this.validationResult();
        case 'index.sync':
          return this.syncIndex();
        default:
          return { error: `Unsupported mdocs command: ${command}`, supportedCommands: this.supportedCommands };
      }
    } catch (err: any) {
      return { error: err.message || String(err) };
    }
  }

  validationResult() {
    const initiativeValidation = this.context.initiatives.validate();
    const wikiValidation = this.context.wiki.validate();
    const allLintResults = this.context.linter.lintAll();
    const graphResults = allLintResults.filter(result => result.file === 'GRAPH');
    const graphErrors = graphResults.flatMap(result => result.issues.filter(issue => issue.severity === 'error').map(issue => `${result.file}: ${issue.message}`));
    const graphWarnings = graphResults.flatMap(result => result.issues.filter(issue => issue.severity !== 'error').map(issue => `${result.file}: ${issue.message}`));
    return {
      initiatives: initiativeValidation,
      wiki: wikiValidation,
      graph: { valid: graphErrors.length === 0, errors: graphErrors, warnings: graphWarnings, results: graphResults },
      valid: initiativeValidation.valid && wikiValidation.valid && graphErrors.length === 0
    };
  }

  private createInitiative(args: Record<string, any>) {
    if (!args.title) return { error: 'initiative.create requires title' };
    const date = today();
    const id = args.id || slugify(args.title);
    const filePath = this.context.initiatives.create({
      id,
      title: args.title,
      status: 'active',
      created: date,
      updated: date,
      owner: args.owner || '',
      tags: Array.isArray(args.tags) ? args.tags : [],
      relatedWiki: Array.isArray(args.relatedWiki) ? args.relatedWiki : [],
      objective: args.objective || '',
      plan: Array.isArray(args.plan)
        ? args.plan.map((item: any) => ({
            description: typeof item === 'string' ? item : item?.description || '',
            status: 'pending' as const
          })).filter((item: any) => item.description)
        : [],
      progressLog: [`[${new Date().toISOString()}] Created initiative via mdocs command`],
      artifacts: [],
      phase: args.phase || undefined,
      handoffSummary: args.handoffSummary || undefined,
      openQuestions: Array.isArray(args.openQuestions) ? args.openQuestions : undefined,
      blockers: Array.isArray(args.blockers) ? args.blockers : undefined,
      nextAction: args.nextAction || undefined
    });
    return { success: true, filename: path.basename(filePath), id };
  }

  private updateInitiative(args: Record<string, any>) {
    if (!args.id) return { error: 'initiative.update requires id' };
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    const updates = args.updates || args;
    for (const field of ['status', 'tags', 'priority', 'dueDate', 'dependsOn', 'owner', 'phase', 'handoffSummary', 'nextAction']) {
      if (updates[field] !== undefined) (initiative as any)[field] = updates[field];
    }
    if (updates.openQuestions !== undefined) initiative.openQuestions = Array.isArray(updates.openQuestions) ? updates.openQuestions : undefined;
    if (updates.blockers !== undefined) initiative.blockers = Array.isArray(updates.blockers) ? updates.blockers : undefined;
    initiative.updated = today();
    if (args.progressNote) initiative.progressLog.push(args.progressNote);
    const filePath = this.context.initiatives.update(fileName, initiative);
    return { success: true, filename: path.basename(filePath), id: initiative.id };
  }

  private doneInitiative(args: Record<string, any>) {
    if (!args.id) return { error: 'initiative.done requires id' };
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    initiative.status = 'done';
    initiative.updated = today();
    initiative.progressLog.push(`[${new Date().toISOString()}] Marked done via mdocs command`);
    const filePath = this.context.initiatives.update(fileName, initiative);
    return { success: true, filename: path.basename(filePath), id: initiative.id };
  }

  private deleteInitiative(args: Record<string, any>) {
    if (!args.id) return { error: 'initiative.delete requires id' };
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    this.context.initiatives.delete(fileName);
    return { success: true, id: args.id, deletedFilename: fileName };
  }

  private archiveInitiative(args: Record<string, any>) {
    if (!args.id) return { error: 'initiative.archive requires id' };
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    if (initiative.status !== 'done') return { error: `Only done initiatives can be archived: ${args.id}` };
    const result = this.context.initiatives.archive(fileName);
    return { success: true, id: args.id, archivedFilename: result.archivedFilename };
  }

  private createWiki(args: Record<string, any>) {
    if (!args.category || !args.id || !args.title) return { error: 'wiki.create requires category, id, and title' };
    const date = today();
    const filePath = this.context.wiki.create({
      category: args.category,
      id: args.id,
      title: args.title,
      created: date,
      updated: date,
      content: args.content || '',
      relatedInitiatives: Array.isArray(args.relatedInitiatives) ? args.relatedInitiatives : [],
      tags: Array.isArray(args.tags) ? args.tags : [],
      lifecycle: args.lifecycle || undefined,
      knowledgeType: args.knowledgeType || undefined,
      confidence: args.confidence || undefined,
      sourceInitiatives: Array.isArray(args.sourceInitiatives) ? args.sourceInitiatives : undefined,
      supersedes: Array.isArray(args.supersedes) ? args.supersedes : undefined,
      relatedWiki: Array.isArray(args.relatedWiki) ? args.relatedWiki : undefined
    });
    return { success: true, filename: path.join(path.basename(path.dirname(filePath)), path.basename(filePath)), id: args.id };
  }

  private updateWiki(args: Record<string, any>) {
    if (!args.category || !args.id) return { error: 'wiki.update requires category and id' };
    const existing = this.context.wiki.read(args.category, args.id);
    if (!existing) return { error: `Wiki entry not found: ${args.category}/${args.id}` };
    if (args.title !== undefined) existing.title = args.title;
    if (args.content !== undefined) existing.content = args.content;
    if (Array.isArray(args.tags)) existing.tags = args.tags;
    if (Array.isArray(args.relatedInitiatives)) existing.relatedInitiatives = args.relatedInitiatives;
    const filePath = this.context.wiki.update(args.category, args.id, existing);
    return { success: true, filename: path.join(path.basename(path.dirname(filePath)), path.basename(filePath)), id: args.id };
  }

  private stubWiki(args: Record<string, any>) {
    if (!args.category || !args.id) return { error: 'wiki.stub requires category and id' };
    const result = this.context.wiki.stub(args.category, args.id, args.title, args.template);
    if (result.existing) return { success: false, existing: true, filePath: path.relative(this.context.mdocsRoot, result.filePath) };
    return { success: true, category: args.category, id: args.id, filePath: path.relative(this.context.mdocsRoot, result.filePath) };
  }

  private deleteWiki(args: Record<string, any>) {
    if (!args.category || !args.id) return { error: 'wiki.delete requires category and id' };
    if (!this.context.wiki.read(args.category, args.id)) return { error: `Wiki entry not found: ${args.category}/${args.id}` };
    this.context.wiki.delete(args.category, args.id);
    return { success: true, category: args.category, id: args.id, deletedFilename: `${args.category}/${args.id}.md` };
  }

  private listWiki(args: Record<string, any>) {
    return {
      entries: this.context.wiki.list(args.category).map(entry => ({
        category: entry.category,
        id: entry.id,
        title: entry.title,
        tags: entry.tags
      }))
    };
  }

  private linkWiki(args: Record<string, any>) {
    if (!args.initiativeId || !args.wikiSlug) return { error: 'wiki.link requires initiativeId and wikiSlug' };
    const [category, entryId] = args.wikiSlug.split('/');
    if (!category || !entryId) return { error: `Invalid wikiSlug format: ${args.wikiSlug}. Expected category/id` };
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.initiativeId);
    if (!fileName) return { error: `Initiative not found: ${args.initiativeId}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.initiativeId}` };
    if (!initiative.relatedWiki.includes(args.wikiSlug)) {
      initiative.relatedWiki.push(args.wikiSlug);
      initiative.updated = today();
      this.context.initiatives.update(fileName, initiative);
    }
    this.context.wiki.addRelatedInitiative(category, entryId, args.initiativeId);
    return { success: true, bidirectional: true, initiativeId: args.initiativeId, wikiSlug: args.wikiSlug };
  }

  private crossReferenceWiki(args: Record<string, any>) {
    if (!args.fromSlug || !args.toSlug) return { error: 'wiki.xref requires fromSlug and toSlug' };
    const [fromCategory, fromId] = args.fromSlug.split('/');
    const [toCategory, toId] = args.toSlug.split('/');
    if (!fromCategory || !fromId) return { error: `Invalid fromSlug format: ${args.fromSlug}. Expected category/id` };
    if (!toCategory || !toId) return { error: `Invalid toSlug format: ${args.toSlug}. Expected category/id` };
    this.context.wiki.addWikiCrossRef(fromCategory, fromId, toCategory, toId);
    return { success: true, bidirectional: true, fromSlug: args.fromSlug, toSlug: args.toSlug };
  }

  private syncIndex() {
    const regenerated = [
      path.relative(this.context.mdocsRoot, this.context.initiatives.syncIndex()),
      ...this.context.wiki.syncIndices().map(filePath => path.relative(this.context.mdocsRoot, filePath))
    ];
    return { success: true, regenerated };
  }
}
```

- [ ] **Step 5: Add commands to factory**

Modify `harness-mdocs/src/core/factory.ts`:

```ts
import { MdocsCommandRegistry } from './commands/registry';
```

Add `commands` to the `MdocsCore` interface:

```ts
  commands: MdocsCommandRegistry;
```

Create the registry before returning:

```ts
  const commands = new MdocsCommandRegistry({
    mdocsRoot,
    mdocs,
    initiatives,
    wiki,
    workflow,
    search,
    audit,
    linter,
    dispatch
  });
```

Return it:

```ts
    commands,
```

- [ ] **Step 6: Export command registry**

Add to `harness-mdocs/src/core/index.ts`:

```ts
export * from './commands/registry';
```

- [ ] **Step 7: Run command tests**

Run from `harness-mdocs/`:

```bash
npm test -- tests/core/commands.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit command registry**

```bash
git add harness-mdocs/src/core harness-mdocs/tests/core/commands.test.ts
git commit -m "feat: add core command registry"
```

---

### Task 6: Rebuild Opencode Adapter Around Core

**Files:**
- Create: `harness-mdocs/src/surfaces/opencode/result.ts`
- Create: `harness-mdocs/src/surfaces/opencode/config.ts`
- Create: `harness-mdocs/src/surfaces/opencode/hooks.ts`
- Create: `harness-mdocs/src/surfaces/opencode/tools.ts`
- Create: `harness-mdocs/src/surfaces/opencode/adapter.ts`
- Create: `harness-mdocs/src/surfaces/opencode/index.ts`
- Create: `harness-mdocs/src/surfaces/opencode/opencode.ts`
- Test: `harness-mdocs/tests/surfaces/opencode/adapter.test.ts`

- [ ] **Step 1: Write opencode adapter tests**

Write `harness-mdocs/tests/surfaces/opencode/adapter.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import opencodePlugin from '../../../src/surfaces/opencode';
import { createOpencodeAdapter } from '../../../src/surfaces/opencode/adapter';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-opencode-'));
}

describe('opencode adapter', () => {
  test('default export returns opencode plugin with mdocs tools', async () => {
    const directory = tempProject();
    const plugin = await opencodePlugin({ client: {}, project: {}, directory });

    expect(plugin.tool.mdocs).toBeDefined();
    expect(plugin.tool.mdocs_init).toBeDefined();
    expect(plugin.tool.mdocs_status).toBeDefined();
    expect(plugin.tool.mdocs_validate).toBeDefined();
  });

  test('tool results are wrapped with output string and metadata', async () => {
    const directory = tempProject();
    const plugin = await opencodePlugin({ client: {}, project: {}, directory });

    await plugin.tool.mdocs_init.execute({});
    const result = await plugin.tool.mdocs.execute({
      command: 'initiative.create',
      args: { id: 'wrapped', title: 'Wrapped Result' }
    });

    expect(typeof result.output).toBe('string');
    expect(result.metadata).toMatchObject({ success: true, id: 'wrapped' });
  });

  test('config hook initializes mdocs and registers bootstrap initiative', () => {
    const directory = tempProject();
    const adapter = createOpencodeAdapter(directory);
    const cfg: any = {};

    adapter.config(cfg);

    const today = new Date().toISOString().split('T')[0];
    expect(fs.existsSync(path.join(directory, 'mdocs', 'initiatives', `install-mdocs--${today}.md`))).toBe(true);
    expect(cfg.agent['mdocs-orchestrator']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `harness-mdocs/`:

```bash
npm test -- tests/surfaces/opencode/adapter.test.ts
```

Expected: FAIL because opencode adapter files do not exist.

- [ ] **Step 3: Implement result wrapping**

Write `harness-mdocs/src/surfaces/opencode/result.ts`:

```ts
export function toOpencodeToolResult(value: any) {
  if (typeof value === 'string') return value;
  if (value && typeof value.output === 'string') return value;
  return {
    output: JSON.stringify(value, null, 2),
    metadata: value && typeof value === 'object' ? value : { value }
  };
}

export function wrapOpencodeToolResults(plugin: any) {
  if (!plugin?.tool) return plugin;
  for (const definition of Object.values(plugin.tool) as any[]) {
    if (!definition || typeof definition.execute !== 'function') continue;
    const execute = definition.execute.bind(definition);
    definition.execute = async (...args: any[]) => toOpencodeToolResult(await execute(...args));
  }
  return plugin;
}
```

- [ ] **Step 4: Implement opencode tool wrappers**

Write `harness-mdocs/src/surfaces/opencode/tools.ts`:

```ts
import { z } from 'zod';
import { MdocsCore } from '../../core';

export function createOpencodeTools(core: MdocsCore) {
  return {
    mdocs: {
      description: 'Run mdocs initiative/wiki commands',
      args: {
        command: z.string().describe('Command name, e.g. initiative.create, initiative.update, validate, index.sync'),
        args: z.record(z.string(), z.any()).optional().describe('Command-specific arguments')
      },
      execute: async (input: { command: string; args?: Record<string, any> }) => core.commands.execute(input.command, input.args || {})
    },
    mdocs_init: {
      description: 'Initialize /mdocs folder structure',
      args: {},
      execute: async () => {
        core.managers.mdocs.init();
        return { success: true };
      }
    },
    mdocs_validate: {
      description: 'Validate mdocs initiative and wiki integrity',
      args: {},
      execute: async () => core.commands.validationResult()
    }
  };
}
```

After this step, add the remaining convenience tools by moving their bodies from `opencode-mdocs/src/plugin.ts` into `createOpencodeTools` while delegating shared aggregate behavior to `core.commands`:

```text
mdocs_status
mdocs_search
mdocs_lookup
mdocs_dispatch
mdocs_audit
mdocs_index_check
mdocs_resume
```

The result payloads must match the current reference implementation.

- [ ] **Step 5: Implement config hook**

Write `harness-mdocs/src/surfaces/opencode/config.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { MdocsCore } from '../../core';

function loadAgentPrompt(agentPath: string) {
  const content = fs.readFileSync(agentPath, 'utf8');
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

export function applyOpencodeConfig(core: MdocsCore, cfg: any) {
  try {
    const agentPath = path.resolve(__dirname, '../../../agents/mdocs-orchestrator.md');
    if (fs.existsSync(agentPath)) {
      if (!cfg.agent) cfg.agent = {};
      if (!cfg.agent['mdocs-orchestrator']) {
        cfg.agent['mdocs-orchestrator'] = {
          description: 'Orchestrates work using the mdocs initiative/wiki workflow.',
          mode: 'primary',
          permission: {
            read: 'allow',
            glob: 'allow',
            grep: 'allow',
            list: 'allow',
            edit: 'allow',
            write: 'allow',
            bash: 'allow'
          },
          prompt: loadAgentPrompt(agentPath)
        };
      }
    }

    const skillsPath = path.resolve(__dirname, '../../../skills');
    if (fs.existsSync(skillsPath)) {
      if (!cfg.skills) cfg.skills = {};
      if (!cfg.skills.paths) cfg.skills.paths = [];
      if (!Array.isArray(cfg.skills.paths)) cfg.skills.paths = [cfg.skills.paths];
      const alreadyAdded = cfg.skills.paths.some((entry: string) => entry === skillsPath);
      if (!alreadyAdded) cfg.skills.paths.push(skillsPath);
    }
  } catch (error) {
    console.error('[mdocs] Config registration skipped:', error);
  }

  core.lifecycle.ensureInitialized();
}
```

- [ ] **Step 6: Implement hooks**

Write `harness-mdocs/src/surfaces/opencode/hooks.ts` by moving the hook logic from `opencode-mdocs/src/plugin.ts` and replacing direct local manager variables with `core.managers`.

The before hook must use:

```ts
if (!core.managers.workflow.canExecuteTool(toolName, toolArgs)) {
  throw new Error(`Workflow gate: ${toolName} blocked at step ${core.managers.workflow.getCurrentStep()}`);
}
```

The after and event hooks must:

- append audit events through `core.managers.audit`
- resolve initiative filenames by id through `findInitiativeFilename`
- update progress logs through `core.managers.initiatives.update`

- [ ] **Step 7: Implement adapter and default export**

Write `harness-mdocs/src/surfaces/opencode/adapter.ts`:

```ts
import { createMdocsCore } from '../../core';
import { applyOpencodeConfig } from './config';
import { createOpencodeHooks } from './hooks';
import { createOpencodeTools } from './tools';

export interface MdocsOpencodeOptions {
  standaloneCategories?: string[];
}

export function createOpencodeAdapter(projectDir: string, options: MdocsOpencodeOptions = {}) {
  const core = createMdocsCore(projectDir, {
    standaloneCategories: options.standaloneCategories,
    bootstrap: {
      installInitiativeTitle: 'Install and Configure opencode-mdocs'
    }
  });
  return {
    config: (cfg: any) => applyOpencodeConfig(core, cfg),
    ...createOpencodeHooks(core),
    tool: createOpencodeTools(core)
  };
}
```

Write `harness-mdocs/src/surfaces/opencode/index.ts`:

```ts
import { createOpencodeAdapter } from './adapter';
import { wrapOpencodeToolResults } from './result';

export { createOpencodeAdapter };

export default (async ({ directory }: { client: any; project: any; directory: string }) => {
  return wrapOpencodeToolResults(createOpencodeAdapter(directory));
}) satisfies any;
```

Write `harness-mdocs/src/surfaces/opencode/opencode.ts`:

```ts
export { default } from './index';
```

- [ ] **Step 8: Run opencode adapter tests**

Run from `harness-mdocs/`:

```bash
npm test -- tests/surfaces/opencode/adapter.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit opencode adapter**

```bash
git add harness-mdocs/src/surfaces/opencode harness-mdocs/tests/surfaces/opencode
git commit -m "feat: add opencode surface adapter"
```

---

### Task 7: Port Opencode Plugin Regression Tests

**Files:**
- Create: `harness-mdocs/tests/surfaces/opencode/plugin-parity.test.ts`
- Modify: `harness-mdocs/src/surfaces/opencode/tools.ts`
- Modify: `harness-mdocs/src/surfaces/opencode/hooks.ts`

- [ ] **Step 1: Copy opencode parity assertions**

Copy behavior tests from `opencode-mdocs/src/__tests__/plugin.test.ts` into `harness-mdocs/tests/surfaces/opencode/plugin-parity.test.ts`.

Keep these assertions:

```text
mdocs_dispatch returns assembled context
mdocs_dispatch uses active initiative
tool.execute.after logs progress to active initiative
event hook logs significant events
config-created initiative uses install-mdocs filename
mdocs_lookup resolves id, title, slug, filename variants
aggregate mdocs command supports initiative and wiki commands
mdocs_validate includes graph lint results
root default export wraps tool results
permission.ask returns allow or ask
tool.execute.before blocks writes before PLAN
```

Remove tests that assert old module paths such as `../plugin`; replace imports with:

```ts
import opencodePlugin from '../../../src/surfaces/opencode';
import { createOpencodeAdapter } from '../../../src/surfaces/opencode/adapter';
```

- [ ] **Step 2: Run parity test**

Run from `harness-mdocs/`:

```bash
npm test -- tests/surfaces/opencode/plugin-parity.test.ts
```

Expected: PASS. Any failure means the adapter is not parity-compatible and must be fixed before Codex work begins.

- [ ] **Step 3: Run full opencode test suite**

Run from `harness-mdocs/`:

```bash
npm run test:opencode
```

Expected: PASS.

- [ ] **Step 4: Commit parity coverage**

```bash
git add harness-mdocs/src/surfaces/opencode harness-mdocs/tests/surfaces/opencode
git commit -m "test: preserve opencode adapter parity"
```

---

### Task 8: Add Shared Prompt Assets

**Files:**
- Create: `harness-mdocs/prompts/mdocs-workflow.md`
- Create: `harness-mdocs/prompts/mdocs-initiative.md`
- Create: `harness-mdocs/prompts/mdocs-orchestrator.md`
- Create: `harness-mdocs/skills/mdocs-workflow/SKILL.md`
- Create: `harness-mdocs/skills/mdocs-initiative/SKILL.md`
- Create: `harness-mdocs/agents/mdocs-orchestrator.md`
- Test: `harness-mdocs/tests/surfaces/opencode/prompt-assets.test.ts`

- [ ] **Step 1: Copy current opencode skills and agent**

Copy:

```text
opencode-mdocs/skills/mdocs-workflow/SKILL.md   -> harness-mdocs/skills/mdocs-workflow/SKILL.md
opencode-mdocs/skills/mdocs-initiative/SKILL.md -> harness-mdocs/skills/mdocs-initiative/SKILL.md
opencode-mdocs/agents/mdocs-orchestrator.md     -> harness-mdocs/agents/mdocs-orchestrator.md
```

Create surface-neutral prompt sources:

```text
harness-mdocs/prompts/mdocs-workflow.md
harness-mdocs/prompts/mdocs-initiative.md
harness-mdocs/prompts/mdocs-orchestrator.md
```

The source prompt files should omit host-specific tool names when possible. If a rendering script is added in the same task, use explicit variable names documented by that renderer. If no renderer is added, write the final text directly without unresolved variables.

- [ ] **Step 2: Add asset test**

Write `harness-mdocs/tests/surfaces/opencode/prompt-assets.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');

test('opencode packaged prompt assets exist', () => {
  expect(fs.existsSync(path.join(root, 'skills', 'mdocs-workflow', 'SKILL.md'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'skills', 'mdocs-initiative', 'SKILL.md'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'agents', 'mdocs-orchestrator.md'))).toBe(true);
});

test('prompt assets do not contain unresolved template placeholders', () => {
  const files = [
    path.join(root, 'skills', 'mdocs-workflow', 'SKILL.md'),
    path.join(root, 'skills', 'mdocs-initiative', 'SKILL.md'),
    path.join(root, 'agents', 'mdocs-orchestrator.md')
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toMatch(/\{\{[^}]+\}\}/);
    expect(content).not.toMatch(/\[[A-Z_]+:/);
  }
});
```

- [ ] **Step 3: Run prompt asset tests**

Run from `harness-mdocs/`:

```bash
npm test -- tests/surfaces/opencode/prompt-assets.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit prompt assets**

```bash
git add harness-mdocs/prompts harness-mdocs/skills harness-mdocs/agents harness-mdocs/tests/surfaces/opencode/prompt-assets.test.ts
git commit -m "feat: add shared mdocs prompt assets"
```

---

### Task 9: Add CLI Command Access For Codex V1

**Files:**
- Create: `harness-mdocs/src/cli/index.ts`
- Create: `harness-mdocs/tests/core/cli.test.ts`

- [ ] **Step 1: Write CLI tests**

Write `harness-mdocs/tests/core/cli.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMdocsCli } from '../../src/cli';

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-cli-'));
}

describe('mdocs CLI', () => {
  test('init creates mdocs structure', async () => {
    const projectDir = tempProject();
    const result = await runMdocsCli(['init'], projectDir);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ success: true });
    expect(fs.existsSync(path.join(projectDir, 'mdocs', 'initiatives', 'INDEX.md'))).toBe(true);
  });

  test('command executes aggregate core command', async () => {
    const projectDir = tempProject();
    await runMdocsCli(['init'], projectDir);

    const result = await runMdocsCli([
      'command',
      'initiative.create',
      '--json',
      '{"id":"cli-created","title":"CLI Created"}'
    ], projectDir);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: true, id: 'cli-created' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `harness-mdocs/`:

```bash
npm test -- tests/core/cli.test.ts
```

Expected: FAIL because `runMdocsCli` does not exist.

- [ ] **Step 3: Implement CLI runner**

Write `harness-mdocs/src/cli/index.ts`:

```ts
#!/usr/bin/env node
import { createMdocsCore } from '../core';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function parseJsonArg(args: string[]) {
  const index = args.indexOf('--json');
  if (index === -1) return {};
  const value = args[index + 1];
  if (!value) throw new Error('--json requires a JSON object string');
  return JSON.parse(value);
}

export async function runMdocsCli(args: string[], projectDir = process.cwd()): Promise<CliResult> {
  try {
    const core = createMdocsCore(projectDir);
    const [command, subcommand] = args;

    if (command === 'init') {
      core.managers.mdocs.init();
      return { exitCode: 0, stdout: JSON.stringify({ success: true }), stderr: '' };
    }

    if (command === 'status') {
      return { exitCode: 0, stdout: JSON.stringify(core.managers.workflow.status(), null, 2), stderr: '' };
    }

    if (command === 'validate') {
      return { exitCode: 0, stdout: JSON.stringify(core.commands.validationResult(), null, 2), stderr: '' };
    }

    if (command === 'command' && subcommand) {
      const payload = parseJsonArg(args);
      const result = await core.commands.execute(subcommand, payload);
      return { exitCode: result.error ? 1 : 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Usage: mdocs init | status | validate | command <name> --json <args-json>'
    };
  } catch (error: any) {
    return { exitCode: 1, stdout: '', stderr: error.message || String(error) };
  }
}

if (require.main === module) {
  runMdocsCli(process.argv.slice(2)).then(result => {
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
  });
}
```

- [ ] **Step 4: Run CLI tests**

Run from `harness-mdocs/`:

```bash
npm test -- tests/core/cli.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit CLI**

```bash
git add harness-mdocs/src/cli harness-mdocs/tests/core/cli.test.ts harness-mdocs/package.json
git commit -m "feat: add mdocs CLI command access"
```

---

### Task 10: Add Codex V1 Plugin Packaging

**Files:**
- Create: `harness-mdocs/src/surfaces/codex/plugin/.codex-plugin/plugin.json`
- Create: `harness-mdocs/src/surfaces/codex/plugin/skills/mdocs-workflow/SKILL.md`
- Create: `harness-mdocs/src/surfaces/codex/plugin/skills/mdocs-initiative/SKILL.md`
- Create: `harness-mdocs/src/surfaces/codex/plugin/skills/mdocs-orchestrator/SKILL.md`
- Create: `harness-mdocs/src/surfaces/codex/index.ts`
- Test: `harness-mdocs/tests/surfaces/codex/plugin.test.ts`

- [ ] **Step 1: Write Codex plugin tests**

Write `harness-mdocs/tests/surfaces/codex/plugin.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

const pluginRoot = path.resolve(__dirname, '../../../src/surfaces/codex/plugin');

describe('Codex plugin packaging', () => {
  test('manifest exists and references existing skills path', () => {
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.name).toBe('mdocs');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.skills).toBe('./skills/');
    expect(fs.existsSync(path.join(pluginRoot, 'skills'))).toBe(true);
    expect(manifest.interface.displayName).toBe('Mdocs');
    expect(manifest.interface.capabilities).toEqual(expect.arrayContaining(['Write', 'Interactive']));
  });

  test('Codex skills use advisory enforcement wording', () => {
    const skillFiles = [
      path.join(pluginRoot, 'skills', 'mdocs-workflow', 'SKILL.md'),
      path.join(pluginRoot, 'skills', 'mdocs-initiative', 'SKILL.md'),
      path.join(pluginRoot, 'skills', 'mdocs-orchestrator', 'SKILL.md')
    ];

    for (const file of skillFiles) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toMatch(/^---\nname:/);
      expect(content).not.toContain('opencode');
      expect(content).not.toContain('Task tool');
      expect(content).not.toContain('plugin blocks');
      expect(content).not.toContain('automatically audited');
      expect(content).not.toMatch(/\{\s*[A-Za-z0-9_]+\s*\}/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `harness-mdocs/`:

```bash
npm test -- tests/surfaces/codex/plugin.test.ts
```

Expected: FAIL because Codex plugin files do not exist.

- [ ] **Step 3: Create Codex plugin manifest**

Write `harness-mdocs/src/surfaces/codex/plugin/.codex-plugin/plugin.json`:

```json
{
  "name": "mdocs",
  "version": "0.1.0",
  "description": "Durable initiative and wiki memory for AI-assisted development.",
  "author": {
    "name": "bbaaxx"
  },
  "license": "MIT",
  "keywords": ["codex", "mdocs", "memory", "workflow", "wiki", "initiatives"],
  "skills": "./skills/",
  "interface": {
    "displayName": "Mdocs",
    "shortDescription": "Shared initiative and wiki memory for coding agents.",
    "longDescription": "Mdocs gives Codex a durable project memory system built from initiatives, wiki entries, workflow state, search, validation, and dispatch context.",
    "developerName": "bbaaxx",
    "category": "Productivity",
    "capabilities": ["Write", "Interactive"],
    "defaultPrompt": [
      "Resume mdocs work",
      "Create an mdocs initiative",
      "Search project memory"
    ],
    "brandColor": "#2563EB"
  }
}
```

- [ ] **Step 4: Create Codex workflow skill**

Write `harness-mdocs/src/surfaces/codex/plugin/skills/mdocs-workflow/SKILL.md`:

```md
---
name: mdocs-workflow
description: Use when starting new mdocs-backed work, resuming initiatives, or managing the development workflow.
---

# Mdocs Workflow For Codex

Use mdocs as durable project memory when the user opts into initiative/wiki tracking.

Codex v1 enforcement is advisory. Do not edit project source files before `PLAN` unless the user explicitly overrides the workflow. Defer destructive shell operations until `COMPLETE`. Use mdocs CLI commands to update progress after substantial actions.

Workflow steps:

1. `UNDERSTAND`: Clarify the request.
2. `DISCOVER`: Check `./mdocs/initiatives/INDEX.md` or run `mdocs status`.
3. `CONTEXT`: Read the initiative and related wiki entries, or run `mdocs command dispatch --json '{"initiativeId":"..."}'` when dispatch is available.
4. `PLAN`: Write or update the initiative plan.
5. `EXECUTE`: Do the implementation work.
6. `VERIFY`: Run project checks and `mdocs validate`.
7. `REPORT`: Update progress and write durable wiki learnings.
8. `COMPLETE`: Mark the initiative done only after validation.

Prefer CLI command access:

```bash
mdocs init
mdocs status
mdocs validate
mdocs command initiative.create --json '{"title":"Add authentication"}'
```

If CLI commands are unavailable, edit `./mdocs` files directly using the documented schema and repair indices before completion.
```

- [ ] **Step 5: Create Codex initiative skill**

Write `harness-mdocs/src/surfaces/codex/plugin/skills/mdocs-initiative/SKILL.md` with the initiative schema from `opencode-mdocs/skills/mdocs-initiative/SKILL.md`, replacing command examples with CLI examples:

```bash
mdocs command initiative.create --json '{"title":"Add authentication","id":"add-authentication"}'
mdocs command initiative.update --json '{"id":"add-authentication","progressNote":"Implemented login form"}'
mdocs command wiki.stub --json '{"category":"architecture","id":"auth-flow","title":"Auth Flow"}'
```

The skill must include the v2 metadata fields: `phase`, `handoff_summary`, `open_questions`, `blockers`, and `next_action`.

- [ ] **Step 6: Create Codex orchestrator skill**

Write `harness-mdocs/src/surfaces/codex/plugin/skills/mdocs-orchestrator/SKILL.md`:

```md
---
name: mdocs-orchestrator
description: Use as the primary mdocs workflow guide for Codex sessions that need durable initiative and wiki memory.
---

# Mdocs Orchestrator For Codex

Start by checking for existing work:

```bash
mdocs status
```

If there is no active initiative and the user wants durable tracking, create one:

```bash
mdocs command initiative.create --json '{"title":"Work title","objective":"Clear objective","plan":["Understand request","Inspect code","Implement","Verify"]}'
```

During work, keep `next_action`, `blockers`, and `handoff_summary` current through `initiative.update`.

Before handing work to another agent or thread, assemble context when command support exists. If dispatch command support is not available in the current CLI build, read the active initiative plus related wiki entries directly.

Before marking work complete:

1. Run project verification commands.
2. Run `mdocs validate`.
3. Write or update at least one stable wiki learning for completed initiatives.
4. Mark the initiative done with `mdocs command initiative.done --json '{"id":"initiative-id"}'`.

Codex v1 follows workflow gates by instruction. It does not block host file edits or shell commands.
```

- [ ] **Step 7: Export Codex surface metadata**

Write `harness-mdocs/src/surfaces/codex/index.ts`:

```ts
export const codexSurface = {
  surface: 'codex',
  capabilities: {
    commandTools: false,
    aggregateCommandTool: false,
    skillPackaging: true,
    agentPackaging: false,
    configMutation: false,
    permissionHooks: false,
    toolExecutionHooks: false,
    eventHooks: false,
    subagentDispatch: 'prompted' as const
  }
};
```

- [ ] **Step 8: Run Codex packaging tests**

Run from `harness-mdocs/`:

```bash
npm test -- tests/surfaces/codex/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 9: Validate plugin manifest with Codex validator**

Run from repository root:

```bash
python3 /Users/bbaaxx/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py harness-mdocs/src/surfaces/codex/plugin
```

Expected: validator exits successfully.

- [ ] **Step 10: Commit Codex plugin packaging**

```bash
git add harness-mdocs/src/surfaces/codex harness-mdocs/tests/surfaces/codex
git commit -m "feat: add codex v1 plugin packaging"
```

---

### Task 11: Add Fixture Round-Trip Compatibility

**Files:**
- Create: `harness-mdocs/tests/fixtures/legacy-mdocs/`
- Create: `harness-mdocs/tests/core/compatibility.test.ts`

- [ ] **Step 1: Create fixture from current mdocs data**

Copy a small representative fixture from `opencode-mdocs/mdocs` into `harness-mdocs/tests/fixtures/legacy-mdocs/mdocs`:

```text
mdocs/.workflow-state.json
mdocs/.index-meta.json
mdocs/audit.log
mdocs/initiatives/INDEX.md
mdocs/initiatives/install-and-configure-opencode-mdocs--2026-05-27.md
mdocs/wiki/INDEX.md
```

Include at least one wiki category with one entry if available. Keep fixture size small enough for fast tests.

- [ ] **Step 2: Write compatibility test**

Write `harness-mdocs/tests/core/compatibility.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMdocsCore } from '../../src/core';

function copyDir(source: string, target: string) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

test('existing mdocs fixture is readable without destructive initialization', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mdocs-compat-'));
  const fixtureRoot = path.resolve(__dirname, '../fixtures/legacy-mdocs');
  copyDir(fixtureRoot, projectDir);

  const before = fs.readFileSync(path.join(projectDir, 'mdocs', 'initiatives', 'INDEX.md'), 'utf8');
  const core = createMdocsCore(projectDir);
  const initResult = core.lifecycle.ensureInitialized();
  const status = core.managers.workflow.status();
  const validation = core.commands.validationResult();
  const after = fs.readFileSync(path.join(projectDir, 'mdocs', 'initiatives', 'INDEX.md'), 'utf8');

  expect(initResult).toEqual({ initialized: false, bootstrapInitiativeCreated: false });
  expect(status.currentStep).toBeDefined();
  expect(validation).toHaveProperty('valid');
  expect(after).toBe(before);
});
```

- [ ] **Step 3: Run compatibility test**

Run from `harness-mdocs/`:

```bash
npm test -- tests/core/compatibility.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit compatibility fixture**

```bash
git add harness-mdocs/tests/fixtures harness-mdocs/tests/core/compatibility.test.ts
git commit -m "test: preserve legacy mdocs compatibility"
```

---

### Task 12: Final Verification And Release Readiness

**Files:**
- Modify: `harness-mdocs/README.md`
- Create: `harness-mdocs/docs/codex-v1.md`
- Create: `harness-mdocs/docs/opencode-parity.md`

- [ ] **Step 1: Document package entrypoints and surfaces**

Update `harness-mdocs/README.md` with:

```md
## Entry Points

- `harness-mdocs/core`: surface-neutral managers, workflow, command registry, validation, search, audit, and dispatch.
- `harness-mdocs/opencode`: opencode adapter preserving the current plugin behavior.
- `harness-mdocs/codex`: Codex v1 surface metadata and plugin packaging.
- `mdocs`: CLI command access for surfaces that do not expose native tools.

## Codex V1 Enforcement

Codex v1 workflow gates are advisory. The plugin skills instruct Codex when to read, plan, edit, verify, and report, but v1 does not block host tool calls or automatically audit every host tool execution.
```

- [ ] **Step 2: Add Codex v1 docs**

Write `harness-mdocs/docs/codex-v1.md`:

```md
# Codex V1

Codex v1 packages mdocs as a Codex plugin with skills and CLI command access.

The v1 surface supports:

- mdocs workflow skill
- mdocs initiative skill
- mdocs orchestrator skill
- CLI access through `mdocs`
- shared core file formats

The v1 surface does not support:

- host-level write blocking
- destructive command blocking
- automatic audit logging for every Codex tool call
- permission hook integration

Use `mdocs validate` before claiming mdocs memory is clean.
```

- [ ] **Step 3: Add opencode parity docs**

Write `harness-mdocs/docs/opencode-parity.md`:

```md
# Opencode Parity

The opencode surface preserves the current `opencode-mdocs` behavior:

- config hook registers the `mdocs-orchestrator` agent
- config hook registers bundled skills
- first run initializes `./mdocs`
- first run creates the bootstrap install initiative
- custom tool names remain available
- tool execution hooks enforce workflow gates
- permission hook returns allow or ask from core workflow decisions
- event and tool hooks append audit events and progress log entries
```

- [ ] **Step 4: Run full verification**

Run from `harness-mdocs/`:

```bash
npm run build
npm test
npm pack
```

Expected: build succeeds, all tests pass, and npm produces a tarball.

- [ ] **Step 5: Validate Codex plugin**

Run from repository root:

```bash
python3 /Users/bbaaxx/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py harness-mdocs/src/surfaces/codex/plugin
```

Expected: plugin validation succeeds.

- [ ] **Step 6: Commit final docs and verification changes**

```bash
git add harness-mdocs
git commit -m "docs: document harness-mdocs surfaces"
```

---

## Acceptance Criteria

- `harness-mdocs` builds as a single TypeScript package.
- Core tests pass against moved managers.
- Core command registry implements the aggregate mdocs command behavior.
- Opencode adapter tests pass and preserve current hook/tool/result behavior.
- Codex plugin manifest validates.
- Codex skills are advisory and contain no opencode-only runtime claims.
- CLI can initialize, validate, and execute aggregate commands against a project.
- Existing valid `./mdocs` fixtures are readable without destructive rewrites.
- README documents the core/surface split and Codex v1 limitations.

## Out Of Scope For This Plan

- Independent npm packages for `core`, `opencode`, and `codex`.
- Codex host-level permission hooks.
- Codex automatic audit logging of every host tool call.
- MCP command access for Codex.
- Publishing `opencode-mdocs` as a wrapper package.

## Self-Review

- Spec coverage: core extraction, command registry, opencode parity, Codex v1 packaging, CLI fallback, fixture compatibility, and verification are covered by Tasks 1-12.
- Scope check: MCP and Codex host enforcement are intentionally excluded because the spec assigns them to later phases.
- Placeholder scan: the plan avoids unresolved template placeholders in files and includes tests to catch bracketed placeholder labels and bare variable braces.
- Type consistency: the factory exposes `commands`, `managers`, and `lifecycle`; later tasks use those names consistently.
