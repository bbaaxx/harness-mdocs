/**
 * Reusable ExtensionAPI mock for pi surface tests.
 *
 * Records `pi.on()` subscriptions, `pi.registerTool()` calls, and
 * `pi.registerCommand()` calls, and provides a fake `ctx` with `cwd`,
 * `hasUI`, `ui.notify`, `sessionManager`, `signal`, and `getSystemPrompt`.
 * Mirrors the shape documented in the pi extensions.md API so the extension
 * factory can be exercised without the real pi runtime.
 */

export interface RecordedHandler {
  event: string;
  handler: (event: any, ctx: any) => Promise<any>;
}

export interface FakeUI {
  notify: jest.Mock;
  setStatus: jest.Mock;
  setWidget: jest.Mock;
}

export interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  ui: FakeUI;
  sessionManager: { getEntries: jest.Mock; getBranch: jest.Mock; getLeafId: jest.Mock };
  signal: AbortSignal | undefined;
  getSystemPrompt: jest.Mock;
}

export function createFakeCtx(cwd: string, opts: { hasUI?: boolean } = {}): FakeCtx {
  return {
    cwd,
    hasUI: opts.hasUI ?? true,
    ui: {
      notify: jest.fn(),
      setStatus: jest.fn(),
      setWidget: jest.fn()
    },
    sessionManager: {
      getEntries: jest.fn(() => []),
      getBranch: jest.fn(() => []),
      getLeafId: jest.fn(() => null)
    },
    signal: undefined,
    getSystemPrompt: jest.fn(() => '')
  };
}

export interface MockExtensionAPI {
  on: jest.Mock;
  registerTool: jest.Mock;
  registerCommand: jest.Mock;
  /** All event subscriptions in registration order. */
  handlers: RecordedHandler[];
  /** All registered tool definitions in registration order. */
  tools: any[];
  /** All registered commands in registration order. */
  commands: Array<{ name: string; options: any }>;
  /** Look up the handler subscribed to an event (last one wins). */
  handlerFor(event: string): RecordedHandler['handler'] | undefined;
}

export function createMockExtensionAPI(): MockExtensionAPI {
  const handlers: RecordedHandler[] = [];
  const tools: any[] = [];
  const commands: Array<{ name: string; options: any }> = [];

  const api: MockExtensionAPI = {
    handlers,
    tools,
    commands,
    on: jest.fn((event: string, handler: (event: any, ctx: any) => Promise<any>) => {
      handlers.push({ event, handler });
    }),
    registerTool: jest.fn((def: any) => {
      tools.push(def);
    }),
    registerCommand: jest.fn((name: string, options: any) => {
      commands.push({ name, options });
    }),
    handlerFor(event: string) {
      const rec = [...handlers].reverse().find(h => h.event === event);
      return rec?.handler;
    }
  };

  return api;
}
