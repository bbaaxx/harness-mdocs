#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMdocsCli = runMdocsCli;
const core_1 = require("../core");
const operations_1 = require("../core/operations");
function parseJsonArg(args) {
    const index = args.indexOf('--json');
    if (index === -1)
        return {};
    const value = args[index + 1];
    if (!value)
        throw new Error('--json requires a JSON object string');
    return JSON.parse(value);
}
function json(value) {
    return JSON.stringify(value, null, 2);
}
function ok(value) {
    return { exitCode: 0, stdout: json(value), stderr: '' };
}
function fail(message) {
    return { exitCode: 1, stdout: '', stderr: message };
}
function text(value) {
    return { exitCode: 0, stdout: value, stderr: '' };
}
function commandHelp(commandName) {
    const examples = {
        'initiative.create': [
            'initiative.create',
            '  Payload: { title, id?, owner?, tags?, objective?, plan?, relatedWiki?, phase?, nextAction? }',
            '  Example:',
            '    mdocs command initiative.create --json \'{"id":"add-auth","title":"Add Auth","objective":"Implement login","plan":["Inspect","Implement","Verify"]}\''
        ],
        'initiative.update': [
            'initiative.update',
            '  Payload: { id, updates?, progressNote? }',
            '  Metadata changes may be nested under updates. progressNote stays top-level.',
            '  Example:',
            '    mdocs command initiative.update --json \'{"id":"add-auth","updates":{"phase":"implementation","nextAction":"Run tests"},"progressNote":"Implemented login form"}\''
        ],
        'wiki.create': [
            'wiki.create',
            '  Payload: { category, id, title, content?, tags?, relatedInitiatives?, lifecycle?, knowledgeType?, confidence?, sourceInitiatives?, supersedes?, relatedWiki? }',
            '  Example:',
            '    mdocs command wiki.create --json \'{"category":"testing","id":"cli-help","title":"CLI Help","content":"Payload examples.","relatedInitiatives":["add-auth"]}\''
        ],
        'wiki.update': [
            'wiki.update',
            '  Payload: { category, id, title?, content?, tags?, relatedInitiatives?, lifecycle?, knowledgeType?, confidence?, sourceInitiatives?, supersedes? }',
            '  Changed fields go at the top level after category and id. Do not use an updates wrapper.',
            '  Example:',
            '    mdocs command wiki.update --json \'{"category":"testing","id":"cli-help","content":"Updated learning.","lifecycle":"stable","sourceInitiatives":["add-auth"]}\''
        ],
        'wiki.ingest': [
            'wiki.ingest',
            '  Payload: { operations: WikiIngestOp[], note?: string }',
            '  Applies a caller-supplied batch atomically under a lock. Never auto-generates prose.',
            '  Op types: createPage, updatePage, updateOverviewSection, appendLog, link.',
            '  Example:',
            '    mdocs command wiki.ingest --json \'{"note":"ship d1","operations":[{"type":"createPage","category":"decisions","id":"d1","title":"D1","content":"decide X"},{"type":"updateOverviewSection","section":"Status","body":"green"},{"type":"appendLog","entry":"shipped d1"}]}\''
        ]
    };
    if (commandName && commandName in examples) {
        return [
            `Usage: mdocs command ${commandName} --json '<payload-json>'`,
            '',
            ...examples[commandName]
        ].join('\n');
    }
    return [
        'Usage: mdocs command <name> --json \'<payload-json>\'',
        '',
        'Runs an mdocs core command with a JSON payload.',
        '',
        'Payload examples:',
        '',
        ...examples['initiative.create'],
        '',
        ...examples['initiative.update'],
        '',
        ...examples['wiki.create'],
        '',
        ...examples['wiki.update'],
        '',
        'Other commands: initiative.done, initiative.delete, initiative.archive, wiki.ingest, wiki.stub, wiki.delete, wiki.list, wiki.link, wiki.xref, lifecycle.graduate, validate, index.sync'
    ].join('\n');
}
async function runMdocsCli(args, projectDir = process.cwd()) {
    try {
        // MCP server: stdio is the JSON-RPC channel, so this branch must run
        // before any core construction and must NOT write to stdout.
        if (args[0] === 'mcp') {
            const { startMcpServer } = await Promise.resolve().then(() => __importStar(require('../surfaces/claude-code/mcp-server')));
            await startMcpServer();
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        // Claude Code hook entrypoints. These read stdin and manage their own exit
        // codes (pre-tool-use may exit 2 to block); delegate and report exit 0 here.
        if (args[0] === 'hooks' && args[1] === 'pre-tool-use') {
            const { runPreToolUse } = await Promise.resolve().then(() => __importStar(require('./hooks/pre-tool-use')));
            await runPreToolUse();
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'hooks' && args[1] === 'post-tool-use') {
            const { runPostToolUse } = await Promise.resolve().then(() => __importStar(require('./hooks/post-tool-use')));
            await runPostToolUse();
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        const core = (0, core_1.createMdocsCore)(projectDir);
        const [command, subcommand] = args;
        if (command === 'init') {
            core.managers.mdocs.init();
            return { exitCode: 0, stdout: JSON.stringify({ success: true }), stderr: '' };
        }
        if (command === 'status') {
            return ok((0, operations_1.status)(core));
        }
        if (command === 'validate') {
            return ok(core.commands.validationResult());
        }
        if (command === 'lookup' && subcommand) {
            const result = (0, operations_1.lookup)(core, subcommand);
            return result.error ? fail(result.error) : ok(result);
        }
        if (command === 'search' && subcommand) {
            return ok({ results: core.managers.search.query(subcommand) });
        }
        if (command === 'resume') {
            return ok((0, operations_1.resume)(core, subcommand));
        }
        if (command === 'reset') {
            return ok((0, operations_1.reset)(core));
        }
        if (command === 'dispatch') {
            const result = (0, operations_1.dispatch)(core, subcommand);
            return result.error ? fail(result.error) : ok(result);
        }
        if (command === 'index' && (subcommand === 'check' || subcommand === 'repair')) {
            return ok((0, operations_1.indexCheck)(core, subcommand === 'repair'));
        }
        if (command === 'step' && subcommand) {
            try {
                return ok((0, operations_1.advance)(core, subcommand));
            }
            catch (error) {
                return fail(error.message || String(error));
            }
        }
        if (command === 'command' && (subcommand === '--help' || subcommand === 'help' || !subcommand)) {
            return text(commandHelp());
        }
        if (command === 'command' && subcommand && args.includes('--help')) {
            return text(commandHelp(subcommand));
        }
        if (command === 'command' && subcommand) {
            const payload = parseJsonArg(args);
            const result = await core.commands.execute(subcommand, payload);
            return result.error ? { exitCode: 1, stdout: json(result), stderr: '' } : ok(result);
        }
        return fail('Usage: mdocs init | status | validate | resume [initiative-id] | reset | lookup <query> | search <query> | dispatch [initiative-id] | index check | index repair | mcp | step <step> | command <name> --json <args-json>');
    }
    catch (error) {
        return fail(error.message || String(error));
    }
}
/* istanbul ignore next */
if (require.main === module) {
    runMdocsCli(process.argv.slice(2)).then(result => {
        if (result.stdout)
            process.stdout.write(`${result.stdout}\n`);
        if (result.stderr)
            process.stderr.write(`${result.stderr}\n`);
        process.exitCode = result.exitCode;
    });
}
//# sourceMappingURL=index.js.map