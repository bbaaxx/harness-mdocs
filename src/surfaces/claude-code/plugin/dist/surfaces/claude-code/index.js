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
exports.skills = exports.withLock = exports.toMcpError = exports.toMcpResult = exports.toCore = exports.parseHookStdin = exports.translateArgs = exports.translateToolName = exports.buildMcpServer = exports.startMcpServer = exports.createClaudeCodeHooks = exports.createClaudeCodeAdapter = exports.claudeCodeSurface = void 0;
exports.claudeCodeSurface = {
    surface: 'claude-code',
    capabilities: {
        commandAccess: 'mcp',
        commandTools: true,
        aggregateCommandTool: true,
        skillPackaging: true,
        agentPackaging: false,
        configMutation: false,
        permissionHooks: true,
        toolExecutionHooks: true,
        eventHooks: true,
        subagentDispatch: 'native'
    }
};
var adapter_1 = require("./adapter");
Object.defineProperty(exports, "createClaudeCodeAdapter", { enumerable: true, get: function () { return adapter_1.createClaudeCodeAdapter; } });
var hooks_1 = require("./hooks");
Object.defineProperty(exports, "createClaudeCodeHooks", { enumerable: true, get: function () { return hooks_1.createClaudeCodeHooks; } });
var mcp_server_1 = require("./mcp-server");
Object.defineProperty(exports, "startMcpServer", { enumerable: true, get: function () { return mcp_server_1.startMcpServer; } });
Object.defineProperty(exports, "buildMcpServer", { enumerable: true, get: function () { return mcp_server_1.buildMcpServer; } });
var translate_1 = require("./translate");
Object.defineProperty(exports, "translateToolName", { enumerable: true, get: function () { return translate_1.translateToolName; } });
Object.defineProperty(exports, "translateArgs", { enumerable: true, get: function () { return translate_1.translateArgs; } });
Object.defineProperty(exports, "parseHookStdin", { enumerable: true, get: function () { return translate_1.parseHookStdin; } });
Object.defineProperty(exports, "toCore", { enumerable: true, get: function () { return translate_1.toCore; } });
var result_1 = require("./result");
Object.defineProperty(exports, "toMcpResult", { enumerable: true, get: function () { return result_1.toMcpResult; } });
Object.defineProperty(exports, "toMcpError", { enumerable: true, get: function () { return result_1.toMcpError; } });
var lock_1 = require("./lock");
Object.defineProperty(exports, "withLock", { enumerable: true, get: function () { return lock_1.withLock; } });
exports.skills = __importStar(require("./skills"));
//# sourceMappingURL=index.js.map