import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { createMdocsCore, SUPPORTED_COMMANDS, COMMAND_DESCRIPTION } from '../../src/core';
import { createOpencodeTools } from '../../src/surfaces/opencode/tools';
import { createPiTools } from '../../src/surfaces/pi/tools';
import { buildMcpServer } from '../../src/surfaces/claude-code/mcp-server';

describe('issue #9: canonical command schema', () => {
  let project: string;
  beforeEach(() => { project = fs.mkdtempSync(path.join(os.tmpdir(), 'mdocs-command-schema-')); });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('all provider-facing schemas derive their enum from runtime allowlist', () => {
    const core = createMdocsCore(project);
    const opencode = createOpencodeTools(core).mdocs;
    const mcp = (buildMcpServer() as any)._registeredTools.mdocs;
    const pi = createPiTools(core).find(tool => tool.name === 'mdocs')!;
    expect(core.commands.supportedCommands).toEqual(SUPPORTED_COMMANDS);
    expect(opencode.args.command.options).toEqual(SUPPORTED_COMMANDS);
    expect(mcp.inputSchema.shape.command.options).toEqual(SUPPORTED_COMMANDS);
    expect((pi.parameters as any).properties.command.enum).toEqual(SUPPORTED_COMMANDS);
    expect(opencode.description).toBe(COMMAND_DESCRIPTION);
    expect(mcp.description).toBe(COMMAND_DESCRIPTION);
    expect(pi.description).toBe(COMMAND_DESCRIPTION);
    for (const file of ['opencode-agent-orchestrator.md', 'claude-agent-orchestrator.md']) {
      const description = fs.readFileSync(path.resolve(__dirname, '../../src/generation/fragments', file), 'utf8');
      for (const command of SUPPORTED_COMMANDS) expect(description).toContain(`\`${command}\``);
    }
    for (const command of SUPPORTED_COMMANDS) expect(z.object(opencode.args).parse({ command, args: {} })).toEqual({ command, args: {} });
  });

  test.each(['invalid', 'wiki.link 中文 to=functions.mdocs', 'wiki.link json argument={', undefined])('rejects %j at schema boundary before execute', command => {
    const core = createMdocsCore(project);
    const execute = jest.spyOn(core.commands, 'execute');
    const tool = createOpencodeTools(core).mdocs;
    expect(z.object(tool.args).safeParse({ command }).success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  test('runtime bypass returns structured retryable error without mutation', async () => {
    const core = createMdocsCore(project);
    const snapshot = () => fs.readdirSync(path.join(project, 'mdocs'), { recursive: true }).map(file => String(file));
    const before = snapshot();
    const command = 'wiki.link 中文 to=functions.mdocs';
    expect(await core.commands.execute(command)).toMatchObject({ success: false, code: 'INVALID_COMMAND', retryable: true, command, supportedCommands: SUPPORTED_COMMANDS });
    expect(snapshot()).toEqual(before);
    expect(await core.commands.execute('validate', {})).toHaveProperty('valid');
  });

  test('MCP schema bypass rejects invalid command before constructing project state', async () => {
    const previous = process.env.MDOCS_PROJECT_DIR;
    process.env.MDOCS_PROJECT_DIR = project;
    try {
      const tool = (buildMcpServer() as any)._registeredTools.mdocs;
      const result = await (tool.callback ?? tool.handler)({ command: 'wiki.link json fragment' }, {});
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ success: false, code: 'INVALID_COMMAND' });
      expect(fs.readdirSync(project)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.MDOCS_PROJECT_DIR;
      else process.env.MDOCS_PROJECT_DIR = previous;
    }
  });
});
