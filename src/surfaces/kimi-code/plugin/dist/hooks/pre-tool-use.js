#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/surfaces/kimi-code/cli/pre-tool-use.ts
var pre_tool_use_exports = {};
__export(pre_tool_use_exports, {
  runPreToolUse: () => runPreToolUse
});
module.exports = __toCommonJS(pre_tool_use_exports);

// src/core/types.ts
function isCompleted(status) {
  return status === "done" || status === "complete";
}
function parseYamlValue(raw) {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
function parseFrontmatter(content) {
  const match = content.match(/---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const front = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) {
      front[key] = parseYamlValue(value);
    }
  }
  return front;
}
function readExpectedDurationRaw(front) {
  return front.expected_duration ?? front.expectedDuration ?? front["expected-duration"];
}

// src/core/config.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
function loadProjectConfig(mdocsRoot) {
  const configPath = path.join(mdocsRoot, ".mdocs.json");
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const source = parsed;
  const config = {};
  if (typeof source.mdocsDirName === "string" && source.mdocsDirName.length > 0) {
    config.mdocsDirName = source.mdocsDirName;
  }
  if (Array.isArray(source.standaloneCategories)) {
    const categories = source.standaloneCategories.filter(
      (category) => typeof category === "string"
    );
    if (categories.length > 0) {
      config.standaloneCategories = categories;
    }
  }
  if (isPlainObject(source.compatibility)) {
    config.compatibility = source.compatibility;
  }
  if (isPlainObject(source.wiki)) {
    config.wiki = source.wiki;
  }
  if (isPlainObject(source.audit)) {
    config.audit = {};
    if (source.audit.level === "full" || source.audit.level === "metadata" || source.audit.level === "off") {
      config.audit.level = source.audit.level;
    }
    if (Number.isInteger(source.audit.maxBytes) && source.audit.maxBytes >= 0) {
      config.audit.maxBytes = source.audit.maxBytes;
    }
    if (Number.isInteger(source.audit.maxBackups) && source.audit.maxBackups >= 0) {
      config.audit.maxBackups = source.audit.maxBackups;
    }
  }
  return config;
}
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// src/core/project-root.ts
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));
var MDOCS_DIR_NAME = "mdocs";
function resolveProjectRoot(cwd) {
  const start = path2.isAbsolute(cwd) ? cwd : path2.resolve(cwd);
  const envDir = process.env.MDOCS_PROJECT_DIR;
  if (envDir && envDir.trim() !== "" && isExistingDir(envDir)) {
    return envDir;
  }
  let dir = start;
  while (true) {
    if (hasMdocsDir(dir)) {
      return dir;
    }
    const parent = path2.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return start;
}
function isExistingDir(dir) {
  try {
    return fs2.existsSync(dir) && fs2.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
function hasMdocsDir(dir) {
  try {
    return fs2.existsSync(path2.join(dir, MDOCS_DIR_NAME)) && fs2.statSync(path2.join(dir, MDOCS_DIR_NAME)).isDirectory();
  } catch {
    return false;
  }
}

// src/core/lock.ts
var fs3 = __toESM(require("fs"));
var path3 = __toESM(require("path"));
var STALE_MS = 5e3;
function withLock(baseDir, name, fn, opts = {}) {
  const lockDir = path3.join(baseDir, `.${name}.lock`);
  const timeoutMs = opts.timeoutMs ?? 250;
  const retryMs = opts.retryMs ?? 15;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs3.mkdirSync(lockDir);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const age = Date.now() - fs3.statSync(lockDir).mtimeMs;
        if (age > STALE_MS) {
          fs3.rmdirSync(lockDir);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return { ran: false };
      const until = Date.now() + retryMs;
      while (Date.now() < until) {
      }
    }
  }
  try {
    return { ran: true, value: fn() };
  } finally {
    try {
      fs3.rmdirSync(lockDir);
    } catch {
    }
  }
}

// src/core/factory.ts
var path13 = __toESM(require("path"));

// src/core/audit.ts
var fs4 = __toESM(require("fs"));
var path4 = __toESM(require("path"));
var MAX_LOG_SIZE = 10 * 1024 * 1024;
var MAX_BACKUPS = 3;
var AuditLog = class {
  logPath;
  level;
  maxBytes;
  maxBackups;
  constructor(baseDir, options = {}) {
    this.logPath = path4.join(baseDir, "audit.log");
    this.level = envAuditLevel() ?? options.level ?? "full";
    this.maxBytes = positiveInt(process.env.MDOCS_AUDIT_MAX_BYTES) ?? options.maxBytes ?? MAX_LOG_SIZE;
    this.maxBackups = positiveInt(process.env.MDOCS_AUDIT_MAX_BACKUPS) ?? options.maxBackups ?? MAX_BACKUPS;
    const dir = path4.dirname(this.logPath);
    if (!fs4.existsSync(dir)) {
      fs4.mkdirSync(dir, { recursive: true });
    }
  }
  rotateIfNeeded() {
    if (!fs4.existsSync(this.logPath)) return;
    const stats = fs4.statSync(this.logPath);
    if (stats.size < this.maxBytes) return;
    if (this.maxBackups <= 0) {
      fs4.unlinkSync(this.logPath);
      return;
    }
    const oldestBackup = `${this.logPath}.${this.maxBackups}`;
    if (fs4.existsSync(oldestBackup)) {
      fs4.unlinkSync(oldestBackup);
    }
    for (let i = this.maxBackups - 1; i >= 1; i--) {
      const backupPath = `${this.logPath}.${i}`;
      const nextPath = `${this.logPath}.${i + 1}`;
      if (fs4.existsSync(backupPath)) {
        fs4.renameSync(backupPath, nextPath);
      }
    }
    fs4.renameSync(this.logPath, `${this.logPath}.1`);
  }
  append(event) {
    if (this.level === "off") return;
    this.rotateIfNeeded();
    const line = JSON.stringify(this.level === "metadata" ? this.metadataOnly(event) : event) + "\n";
    fs4.appendFileSync(this.logPath, line, "utf8");
  }
  metadataOnly(event) {
    const details = event.details || {};
    return {
      ...event,
      details: {
        toolName: details.toolName,
        eventType: details.eventType,
        operation: details.operation,
        command: details.command
      }
    };
  }
  query(options = {}) {
    if (!fs4.existsSync(this.logPath)) return [];
    const lines = fs4.readFileSync(this.logPath, "utf8").split("\n").filter(Boolean);
    const events = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (options.type && event.type !== options.type) continue;
        if (options.initiativeId && event.initiativeId !== options.initiativeId) continue;
        if (options.startDate && event.timestamp < options.startDate) continue;
        if (options.endDate && event.timestamp > options.endDate) continue;
        events.push(event);
      } catch {
      }
    }
    if (options.limit) {
      return events.slice(-options.limit);
    }
    return events;
  }
  summarize(initiativeId) {
    return this.query({ initiativeId });
  }
};
function positiveInt(value) {
  if (!value) return void 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : void 0;
}
function envAuditLevel() {
  const value = process.env.MDOCS_AUDIT_LEVEL;
  return value === "full" || value === "metadata" || value === "off" ? value : void 0;
}

// src/core/commands/registry.ts
var path6 = __toESM(require("path"));

// src/core/workflow/engine.ts
var fs5 = __toESM(require("fs"));
var path5 = __toESM(require("path"));
var STEPS = [
  "IDLE",
  "UNDERSTAND",
  "DISCOVER",
  "CONTEXT",
  "PLAN",
  "EXECUTE",
  "VERIFY",
  "REPORT",
  "COMPLETE"
];
var WorkflowEngine = class {
  statePath;
  state;
  enforcementMode;
  idle;
  constructor(baseDir, options = {}) {
    this.statePath = path5.join(baseDir, ".workflow-state.json");
    this.state = this.load();
    this.enforcementMode = options.enforcementMode ?? "gate";
    this.idle = options.idle ?? "open";
  }
  load() {
    if (fs5.existsSync(this.statePath)) {
      return JSON.parse(fs5.readFileSync(this.statePath, "utf8"));
    }
    return {
      currentStep: "IDLE",
      activeInitiative: null,
      stepHistory: []
    };
  }
  save() {
    const dir = path5.dirname(this.statePath);
    if (!fs5.existsSync(dir)) {
      fs5.mkdirSync(dir, { recursive: true });
    }
    fs5.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }
  getCurrentStep() {
    return this.state.currentStep;
  }
  /**
   * Advance to the next step (no-skip, no-back).
   *
   * Single-writer by design: no lock is taken here. Advances are inherently
   * sequential — one agent, one currentStep — so the race requires concurrent
   * `mdocs_advance` calls on the same state file, which is not a real access
   * pattern. PostToolUse wraps its initiative read-modify-write in `withLock`
   * because Claude Code fans out tool calls in parallel; advance does not have
   * that shape. Revisit only if a multi-writer surface is introduced.
   * See workflow-enforcement-dogfood-friction-log F5.
   */
  advance(nextStep) {
    const currentIndex = STEPS.indexOf(this.state.currentStep);
    const nextIndex = STEPS.indexOf(nextStep);
    if (nextIndex < currentIndex) {
      throw new Error(`Cannot go back from ${this.state.currentStep} to ${nextStep}`);
    }
    if (nextIndex > currentIndex + 1) {
      throw new Error(`Cannot skip from ${this.state.currentStep} to ${nextStep}`);
    }
    this.state.stepHistory.push({
      step: nextStep,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    this.state.currentStep = nextStep;
    this.save();
  }
  isMdocsOperation(toolName, toolArgs) {
    const args = toolArgs || {};
    const isMdocsPath = (p) => {
      return p.includes("/mdocs/") || p.includes("\\mdocs\\") || p.startsWith("mdocs/") || p.startsWith("mdocs\\");
    };
    if (args.filePath && typeof args.filePath === "string" && isMdocsPath(args.filePath)) {
      return true;
    }
    if (args.path && typeof args.path === "string" && isMdocsPath(args.path)) {
      return true;
    }
    if (args.pattern && typeof args.pattern === "string" && isMdocsPath(args.pattern)) {
      return true;
    }
    if (toolName === "bash") {
      const command = args.command || args.args?.command || "";
      if (typeof command === "string" && isMdocsPath(command)) {
        return true;
      }
    }
    return false;
  }
  canExecuteTool(toolName, toolArgs) {
    if (this.enforcementMode === "off") return true;
    const readTools = ["read", "glob", "grep", "list"];
    const writeTools = ["edit", "write"];
    if (this.isMdocsOperation(toolName, toolArgs)) {
      return true;
    }
    if (readTools.includes(toolName)) return true;
    if (this.state.currentStep === "IDLE") {
      return this.idle === "open";
    }
    if (this.enforcementMode === "advisory") return true;
    if (writeTools.includes(toolName)) {
      return ["PLAN", "EXECUTE", "VERIFY", "REPORT", "COMPLETE"].includes(this.state.currentStep);
    }
    return true;
  }
  status() {
    return this.state;
  }
  setActiveInitiative(initiativeId) {
    this.state.activeInitiative = initiativeId;
    this.save();
  }
  resumeAt(step) {
    this.state.currentStep = step;
    this.state.stepHistory.push({ step, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    this.save();
  }
  /**
   * Reset to a clean slate: IDLE + no active initiative. Pushes a history
   * entry so the transition is visible in the trail. Used by `mdocs_reset`
   * to abandon an initiative mid-flight, force-reset for testing, or begin a
   * fresh initiative cycle after COMPLETE.
   */
  reset() {
    this.state.activeInitiative = null;
    this.state.currentStep = "IDLE";
    this.state.stepHistory.push({ step: "IDLE", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    this.save();
  }
};

// src/core/commands/utils.ts
function today() {
  return (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
}
function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function findInitiativeFilename(mdocsRoot, initiatives, id) {
  void mdocsRoot;
  return initiatives.findKeyById(id);
}
var KEY_ALIASES = {
  related_initiatives: "relatedInitiatives",
  source_initiatives: "sourceInitiatives",
  sources: "sourceInitiatives",
  knowledge_type: "knowledgeType",
  related_wiki: "relatedWiki",
  due_date: "dueDate",
  depends_on: "dependsOn",
  handoff_summary: "handoffSummary",
  open_questions: "openQuestions",
  next_action: "nextAction",
  expected_duration: "expectedDuration",
  initiative_id: "initiativeId",
  wiki_slug: "wikiSlug"
};
function normalizeCommandKeys(args) {
  const out = { ...args };
  for (const [snake, camel] of Object.entries(KEY_ALIASES)) {
    if (out[snake] !== void 0 && out[camel] === void 0) {
      out[camel] = out[snake];
    }
    delete out[snake];
  }
  return out;
}

// src/core/commands/registry.ts
function unique(values) {
  return Array.from(new Set(values));
}
function fieldsPersistedEqual(actual, expected) {
  const normalize = (v) => v === void 0 || Array.isArray(v) && v.length === 0 ? null : v;
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}
function countIssues(errors, warnings, infos = []) {
  return {
    errorCount: errors.length,
    warningCount: warnings.length,
    infoCount: infos.length,
    clean: errors.length === 0 && warnings.length === 0
  };
}
var MdocsCommandRegistry = class {
  constructor(context) {
    this.context = context;
  }
  context;
  supportedCommands = [
    "initiative.create",
    "initiative.update",
    "initiative.done",
    "initiative.delete",
    "initiative.archive",
    "wiki.create",
    "wiki.update",
    "wiki.ingest",
    "wiki.stub",
    "wiki.delete",
    "wiki.list",
    "wiki.link",
    "wiki.xref",
    "workflow.advance",
    "workflow.reset",
    "lifecycle.graduate",
    "validate",
    "index.sync"
  ];
  async execute(command, args = {}) {
    try {
      switch (command) {
        case "initiative.create":
          return this.createInitiative(args);
        case "initiative.update":
          return this.updateInitiative(args);
        case "initiative.done":
          return this.doneInitiative(args);
        case "initiative.delete":
          return this.deleteInitiative(args);
        case "initiative.archive":
          return this.archiveInitiative(args);
        case "wiki.create":
          return this.createWiki(args);
        case "wiki.update":
          return this.updateWiki(args);
        case "wiki.ingest":
          return this.ingestWiki(args);
        case "wiki.stub":
          return this.stubWiki(args);
        case "wiki.delete":
          return this.deleteWiki(args);
        case "wiki.list":
          return this.listWiki(args);
        case "wiki.link":
          return this.linkWiki(args);
        case "wiki.xref":
          return this.crossReferenceWiki(args);
        case "workflow.advance":
          return this.advanceWorkflow(args);
        case "workflow.reset":
          return this.resetWorkflow();
        case "lifecycle.graduate":
          return this.graduateInitiative(args);
        case "validate":
          return this.validationResult();
        case "index.sync":
          return this.syncIndex();
        default:
          return { error: `Unsupported mdocs command: ${command}`, supportedCommands: this.supportedCommands };
      }
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }
  resetWorkflow() {
    this.context.workflow.reset();
    return {
      success: true,
      currentStep: this.context.workflow.getCurrentStep(),
      activeInitiative: this.context.workflow.status().activeInitiative,
      stepHistory: this.context.workflow.status().stepHistory
    };
  }
  advanceWorkflow(args) {
    const step = args.step || args.nextStep;
    if (!step || typeof step !== "string") {
      return { error: "workflow.advance requires { step: StepName }", validSteps: STEPS };
    }
    if (!STEPS.includes(step)) {
      return { error: `Invalid workflow step: ${step}`, validSteps: STEPS };
    }
    try {
      this.context.workflow.advance(step);
    } catch (err) {
      return { error: err.message || String(err), currentStep: this.context.workflow.getCurrentStep() };
    }
    return {
      success: true,
      currentStep: this.context.workflow.getCurrentStep(),
      activeInitiative: this.context.workflow.status().activeInitiative,
      stepHistory: this.context.workflow.status().stepHistory
    };
  }
  /**
   * lifecycle.graduate — record a completed initiative's learning into the
   * compiled views (overview.md sections + log.md entry) using the G2a helpers,
   * wrapped in withLock, and stamp the initiative `graduated` so the
   * graduation-due lint rule clears.
   *
   * INVARIANT: NEVER auto-generates prose. Only caller-supplied `sections`
   * bodies and `logEntry` content are written. Best-effort batch like ingest:
   * each section/log write is isolated in its own try/catch; a failing write
   * records an error but does NOT abort the rest. The `graduated` stamp is
   * applied last; if it throws, the write results are still returned with the
   * stamp error included.
   */
  graduateInitiative(args) {
    if (!args.id) return { error: "lifecycle.graduate requires id" };
    this.context.initiatives.assertWriteSupported("lifecycle.graduate");
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    if (!isCompleted(initiative.status)) {
      return { error: `Only completed initiatives can be graduated (current status: ${initiative.status})` };
    }
    const sections = Array.isArray(args.sections) ? args.sections : [];
    const logEntry = args.logEntry;
    const lockResult = withLock(this.context.mdocsRoot, "lifecycle-graduate", () => {
      const sectionResults2 = [];
      let logResult2 = void 0;
      for (const s of sections) {
        try {
          const p = this.context.wiki.updateOverviewSection(s.section, s.body);
          sectionResults2.push({
            section: s.section,
            ok: true,
            skipped: p === null ? "non-directory-v2" : void 0,
            filePath: p ? path6.relative(this.context.mdocsRoot, p) : void 0
          });
        } catch (err) {
          sectionResults2.push({ section: s.section, ok: false, error: err.message || String(err) });
        }
      }
      if (logEntry !== void 0) {
        try {
          const p = this.context.wiki.appendLog(logEntry);
          logResult2 = {
            ok: true,
            skipped: p === null ? "non-directory-v2" : void 0,
            filePath: p ? path6.relative(this.context.mdocsRoot, p) : void 0
          };
        } catch (err) {
          logResult2 = { ok: false, error: err.message || String(err) };
        }
      }
      let stampError2;
      try {
        initiative.graduated = today();
        this.context.initiatives.update(fileName, initiative);
      } catch (stampErr) {
        stampError2 = stampErr.message || String(stampErr);
      }
      return { sectionResults: sectionResults2, logResult: logResult2, stampError: stampError2 };
    });
    if (!lockResult.ran || lockResult.value === void 0) {
      return { success: false, error: "lifecycle-graduate lock timeout" };
    }
    const { sectionResults, logResult, stampError } = lockResult.value;
    const wrote = { overviewSections: sectionResults };
    if (logResult !== void 0) wrote.logEntry = logResult;
    const result = {
      success: true,
      initiativeId: initiative.id,
      graduated: today(),
      wrote
    };
    if (stampError) result.stampError = stampError;
    return result;
  }
  validationResult() {
    const initiativeValidation = this.context.initiatives.validate();
    const wikiValidation = this.context.wiki.validate();
    const allLintResults = this.context.linter.lintAll();
    const graphResults = allLintResults.filter((result) => result.file === "GRAPH");
    const graphErrors = graphResults.flatMap(
      (result) => result.issues.filter((issue) => issue.severity === "error").map((issue) => `${result.file}: ${issue.message}`)
    );
    const graphWarnings = graphResults.flatMap(
      (result) => result.issues.filter((issue) => issue.severity === "warning").map((issue) => `${result.file}: ${issue.message}`)
    );
    const graphInfos = graphResults.flatMap(
      (result) => result.issues.filter((issue) => issue.severity === "info").map((issue) => `${result.file}: ${issue.message}`)
    );
    const initiativeErrors = unique(initiativeValidation.errors);
    const initiativeWarnings = unique(initiativeValidation.warnings);
    const wikiErrors = unique(wikiValidation.errors);
    const wikiWarnings = unique(wikiValidation.warnings);
    const uniqueGraphErrors = unique(graphErrors);
    const uniqueGraphWarnings = unique(graphWarnings);
    const uniqueGraphInfos = unique(graphInfos);
    const errorCount = initiativeErrors.length + wikiErrors.length + uniqueGraphErrors.length;
    const warningCount = initiativeWarnings.length + wikiWarnings.length + uniqueGraphWarnings.length;
    const infoCount = uniqueGraphInfos.length;
    return {
      initiatives: { ...initiativeValidation, errors: initiativeErrors, warnings: initiativeWarnings, ...countIssues(initiativeErrors, initiativeWarnings) },
      wiki: { ...wikiValidation, errors: wikiErrors, warnings: wikiWarnings, ...countIssues(wikiErrors, wikiWarnings) },
      graph: { valid: uniqueGraphErrors.length === 0, errors: uniqueGraphErrors, warnings: uniqueGraphWarnings, infos: uniqueGraphInfos, results: graphResults, ...countIssues(uniqueGraphErrors, uniqueGraphWarnings, uniqueGraphInfos) },
      valid: initiativeValidation.valid && wikiValidation.valid && uniqueGraphErrors.length === 0,
      errorCount,
      warningCount,
      infoCount,
      clean: errorCount === 0 && warningCount === 0
    };
  }
  createInitiative(args) {
    if (!args.title) return { error: "initiative.create requires title" };
    this.context.initiatives.assertWriteSupported("initiative.create");
    const date = today();
    const id = args.id || slugify(args.title);
    const filePath = this.context.initiatives.create({
      id,
      title: args.title,
      status: "active",
      created: date,
      updated: date,
      owner: args.owner || "",
      tags: Array.isArray(args.tags) ? args.tags : [],
      aliases: Array.isArray(args.aliases) ? args.aliases : [],
      relatedWiki: Array.isArray(args.relatedWiki) ? args.relatedWiki : [],
      objective: args.objective || "",
      plan: Array.isArray(args.plan) ? args.plan.map((item) => ({
        description: typeof item === "string" ? item : item?.description || "",
        status: "pending"
      })).filter((item) => item.description) : [],
      progressLog: [`[${(/* @__PURE__ */ new Date()).toISOString()}] Created initiative via mdocs command`],
      artifacts: [],
      phase: args.phase || void 0,
      handoffSummary: args.handoffSummary || void 0,
      openQuestions: Array.isArray(args.openQuestions) ? args.openQuestions : void 0,
      blockers: Array.isArray(args.blockers) ? args.blockers : void 0,
      nextAction: args.nextAction || void 0,
      expectedDuration: args.expectedDuration || void 0,
      graduated: args.graduated || void 0
    });
    return {
      success: true,
      filename: path6.basename(filePath),
      id,
      hint: "Initiative created but not active. Run mdocs_resume (or CLI: mdocs resume <id>) to activate it."
    };
  }
  /**
   * initiative.update — explicit mutation result. snake_case inputs are
   * normalized to camelCase. Fields the store will not persist are reported
   * in `skippedFields` (metadata-only mode: anything outside the lifecycle
   * set, plus an unpersisted progressNote); fields the command does not
   * support at all (objective, plan, unknown keys) are rejected explicitly in
   * `unsupportedFields` with no write. Persisted fields are verified by
   * re-reading the initiative from disk before they are reported as applied.
   */
  updateInitiative(rawArgs) {
    const args = normalizeCommandKeys(rawArgs);
    if (!args.id) return { error: "initiative.update requires id" };
    this.context.initiatives.assertWriteSupported("initiative.update");
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    const updates = normalizeCommandKeys(args.updates || args);
    const SUPPORTED = /* @__PURE__ */ new Set(["status", "tags", "aliases", "relatedWiki", "priority", "dueDate", "dependsOn", "owner", "phase", "handoffSummary", "nextAction", "expectedDuration", "graduated", "openQuestions", "blockers"]);
    const CONTROL_KEYS = /* @__PURE__ */ new Set(["id", "updates", "progressNote"]);
    const metadataOnly = this.context.contract.initiativeMode === "directory" && this.context.contract.initiativeRecordMode === "metadata-only";
    const appliedFields = [];
    const appliedValues = {};
    const skippedFields = [];
    const unsupportedFields = [];
    for (const field of Object.keys(updates)) {
      if (CONTROL_KEYS.has(field) || updates[field] === void 0) continue;
      if (!SUPPORTED.has(field)) {
        unsupportedFields.push(field);
        continue;
      }
      if (metadataOnly && !this.metadataOnlyPersistable(field, initiative)) {
        skippedFields.push(field);
        continue;
      }
      const appliedValue = field === "openQuestions" || field === "blockers" ? Array.isArray(updates[field]) ? updates[field] : void 0 : updates[field];
      initiative[field] = appliedValue;
      appliedFields.push(field);
      appliedValues[field] = appliedValue;
    }
    if (unsupportedFields.length > 0) {
      return {
        success: false,
        error: `initiative.update does not support fields: ${unsupportedFields.join(", ")}`,
        unsupportedFields,
        skippedFields,
        appliedFields: [],
        id: args.id
      };
    }
    if (args.progressNote !== void 0) {
      if (metadataOnly) {
        skippedFields.push("progressNote");
      } else {
        initiative.progressLog.push(args.progressNote);
        appliedFields.push("progressNote");
      }
    }
    initiative.updated = today();
    const filePath = this.context.initiatives.update(fileName, initiative);
    const after = this.context.initiatives.read(path6.basename(filePath));
    const failedFields = appliedFields.filter((field) => field !== "progressNote").filter((field) => {
      const actual = after?.[field];
      const expected = appliedValues[field];
      if (field === "status" && isCompleted(actual) && isCompleted(expected)) return false;
      return !fieldsPersistedEqual(actual, expected);
    });
    if (failedFields.length > 0) {
      return {
        success: false,
        error: `initiative.update postcondition failed: fields not persisted: ${failedFields.join(", ")}`,
        failedFields,
        appliedFields: appliedFields.filter((field) => !failedFields.includes(field)),
        skippedFields,
        unsupportedFields,
        id: initiative.id
      };
    }
    return { success: true, filename: path6.basename(filePath), id: initiative.id, appliedFields, skippedFields, unsupportedFields };
  }
  /**
   * Whether initiative.update can persist `field` under metadata-only mode.
   * Only lifecycle keys are rewritten; next_action only when the consumer
   * file already carries the key.
   */
  metadataOnlyPersistable(field, initiative) {
    if (field === "status" || field === "graduated") return true;
    if (field === "nextAction") return initiative.nextAction !== void 0;
    return false;
  }
  doneInitiative(args) {
    if (!args.id) return { error: "initiative.done requires id" };
    this.context.initiatives.assertWriteSupported("initiative.done");
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    const result = this.context.initiatives.markDone(fileName);
    if (this.context.workflow.status().activeInitiative === initiative.id) {
      this.context.workflow.setActiveInitiative(null);
    }
    return { success: true, filename: result.filename, id: initiative.id };
  }
  deleteInitiative(args) {
    if (!args.id) return { error: "initiative.delete requires id" };
    this.context.initiatives.assertWriteSupported("initiative.delete");
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    this.context.initiatives.delete(fileName);
    return { success: true, id: args.id, deletedFilename: fileName };
  }
  archiveInitiative(args) {
    if (!args.id) return { error: "initiative.archive requires id" };
    this.context.initiatives.assertWriteSupported("initiative.archive");
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.id);
    if (!fileName) return { error: `Initiative not found: ${args.id}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.id}` };
    if (!isCompleted(initiative.status)) return { error: `Only completed initiatives can be archived: ${args.id}` };
    const result = this.context.initiatives.archive(fileName);
    return { success: true, id: args.id, archivedFilename: result.archivedFilename };
  }
  createWiki(rawArgs) {
    const args = normalizeCommandKeys(rawArgs);
    if (!args.id || !args.title) return { error: "wiki.create requires id and title" };
    const date = today();
    const category = args.category || "";
    const filePath = this.context.wiki.create({
      category,
      id: args.id,
      title: args.title,
      created: date,
      updated: date,
      content: args.content || "",
      relatedInitiatives: Array.isArray(args.relatedInitiatives) ? args.relatedInitiatives : [],
      tags: Array.isArray(args.tags) ? args.tags : [],
      status: args.status || void 0,
      lifecycle: args.lifecycle || void 0,
      knowledgeType: args.knowledgeType || void 0,
      confidence: args.confidence || void 0,
      sourceInitiatives: Array.isArray(args.sourceInitiatives) ? args.sourceInitiatives : void 0,
      supersedes: Array.isArray(args.supersedes) ? args.supersedes : void 0,
      relatedWiki: Array.isArray(args.relatedWiki) ? args.relatedWiki : void 0
    });
    return { success: true, filename: category ? path6.join(path6.basename(path6.dirname(filePath)), path6.basename(filePath)) : path6.basename(filePath), id: args.id };
  }
  /**
   * wiki.update — lossless, explicit mutation result. snake_case inputs are
   * normalized to camelCase. Unknown fields are rejected in
   * `unsupportedFields` with no write. Requested changes are verified by
   * re-reading the page from disk; if a requested change did not persist the
   * result is non-success with the failed fields listed.
   */
  updateWiki(rawArgs) {
    const args = normalizeCommandKeys(rawArgs);
    if (!args.id) return { error: "wiki.update requires id" };
    const KNOWN = /* @__PURE__ */ new Set(["id", "category", "title", "content", "tags", "relatedInitiatives", "status", "lifecycle", "knowledgeType", "confidence", "sourceInitiatives", "supersedes", "relatedWiki"]);
    const unsupportedFields = Object.keys(args).filter((key) => args[key] !== void 0 && !KNOWN.has(key));
    if (unsupportedFields.length > 0) {
      return {
        success: false,
        error: `wiki.update does not support fields: ${unsupportedFields.join(", ")}`,
        unsupportedFields,
        id: args.id
      };
    }
    const category = args.category || "";
    const existing = category ? this.context.wiki.read(category, args.id) : this.context.wiki.readByRef(args.id);
    if (!existing) return { error: `Wiki entry not found: ${category ? `${category}/` : ""}${args.id}` };
    const rawIdentity = {
      id: existing.rawFrontmatter?.values.id,
      category: existing.rawFrontmatter?.values.category
    };
    const appliedFields = [];
    const appliedValues = {};
    const apply = (field, value) => {
      existing[field] = value;
      appliedFields.push(field);
      appliedValues[field] = value;
    };
    if (args.title !== void 0) apply("title", args.title);
    if (args.content !== void 0) apply("content", args.content);
    if (Array.isArray(args.tags)) apply("tags", args.tags);
    if (Array.isArray(args.relatedInitiatives)) apply("relatedInitiatives", args.relatedInitiatives);
    if (args.status !== void 0) apply("status", args.status);
    if (args.lifecycle !== void 0) apply("lifecycle", args.lifecycle);
    if (args.knowledgeType !== void 0) apply("knowledgeType", args.knowledgeType);
    if (args.confidence !== void 0) apply("confidence", args.confidence);
    if (Array.isArray(args.sourceInitiatives)) apply("sourceInitiatives", args.sourceInitiatives);
    if (Array.isArray(args.supersedes)) apply("supersedes", args.supersedes);
    if (Array.isArray(args.relatedWiki)) apply("relatedWiki", args.relatedWiki);
    const filePath = this.context.wiki.update(category, args.id, existing);
    const after = category ? this.context.wiki.read(category, args.id) : this.context.wiki.readByRef(args.id);
    const failedFields = appliedFields.filter((field) => {
      const actual = after?.[field];
      const expected = appliedValues[field];
      if (field === "content") return String(actual ?? "").trim() !== String(expected ?? "").trim();
      return !fieldsPersistedEqual(actual, expected);
    });
    if (!fieldsPersistedEqual(after?.rawFrontmatter?.values.id, rawIdentity.id) || !fieldsPersistedEqual(after?.rawFrontmatter?.values.category, rawIdentity.category)) {
      failedFields.push("raw identity/category");
    }
    if (failedFields.length > 0) {
      return {
        success: false,
        error: `wiki.update postcondition failed: fields not persisted: ${failedFields.join(", ")}`,
        failedFields,
        appliedFields: appliedFields.filter((field) => !failedFields.includes(field)),
        id: args.id
      };
    }
    return { success: true, filename: category ? path6.join(path6.basename(path6.dirname(filePath)), path6.basename(filePath)) : path6.basename(filePath), id: args.id, appliedFields, unsupportedFields: [] };
  }
  stubWiki(args) {
    if (!args.id) return { error: "wiki.stub requires id" };
    const result = this.context.wiki.stub(args.category || "", args.id, args.title, args.template);
    if (result.existing) return { success: false, existing: true, filePath: path6.relative(this.context.mdocsRoot, result.filePath) };
    return { success: true, category: args.category, id: args.id, filePath: path6.relative(this.context.mdocsRoot, result.filePath) };
  }
  deleteWiki(args) {
    if (!args.id) return { error: "wiki.delete requires id" };
    const category = args.category || "";
    const existing = category ? this.context.wiki.read(category, args.id) : this.context.wiki.readByRef(args.id);
    if (!existing) return { error: `Wiki entry not found: ${category ? `${category}/` : ""}${args.id}` };
    this.context.wiki.delete(category, args.id);
    return { success: true, category, id: args.id, deletedFilename: category ? `${category}/${args.id}.md` : `${args.id}.md` };
  }
  listWiki(args) {
    return {
      entries: this.context.wiki.list(args.category).map((entry) => ({
        category: entry.category,
        id: entry.id,
        title: entry.title,
        tags: entry.tags
      }))
    };
  }
  /**
   * wiki.link — bidirectional, postcondition-verified link.
   *
   * - Under directory metadata-only mode the initiative-side `related_wiki`
   *   is persisted via a surgical frontmatter-array mutation (the whitelisted
   *   update would silently drop it).
   * - Self-backlink guard: linking an initiative to its own compiled page
   *   (category `initiatives`/`initiative`, id equal to the initiative id) is
   *   provenance, not a link — no self `related_initiatives` entry and no
   *   `related_wiki` self-entry are written; the result is success with
   *   `selfLink: true`, never `bidirectional: true`.
   * - After both writes, both sides are read back from disk; only a verified
   *   pair returns `bidirectional: true`. If the wiki side fails after the
   *   initiative side was written, the initiative side is rolled back
   *   surgically so no partial mutation remains.
   */
  linkWiki(rawArgs) {
    const args = normalizeCommandKeys(rawArgs);
    if (!args.initiativeId || !args.wikiSlug) return { error: "wiki.link requires initiativeId and wikiSlug" };
    this.context.initiatives.assertWriteSupported("wiki.link");
    const rawParts = String(args.wikiSlug).split("/");
    if (rawParts.some((part) => !part)) return { error: `Invalid wikiSlug format: ${args.wikiSlug}. Expected id or category/id` };
    const parts = rawParts;
    if (parts.length !== 1 && parts.length !== 2) return { error: `Invalid wikiSlug format: ${args.wikiSlug}. Expected id or category/id` };
    const normalizedParts = parts.map((part, index) => index === parts.length - 1 ? part.replace(/\.md$/, "") : part);
    const wikiSlug = normalizedParts.join("/");
    if (normalizedParts.length === 1 && normalizedParts[0].toLowerCase() === "index") return { error: "Refusing to overwrite canonical root wiki index: index" };
    const wikiEntry = this.context.wiki.readByRef(wikiSlug);
    if (!wikiEntry) return { error: `Wiki entry not found: ${wikiSlug}` };
    const fileName = findInitiativeFilename(this.context.mdocsRoot, this.context.initiatives, args.initiativeId);
    if (!fileName) return { error: `Initiative not found: ${args.initiativeId}` };
    const initiative = this.context.initiatives.read(fileName);
    if (!initiative) return { error: `Initiative not found: ${args.initiativeId}` };
    const wikiCategory = (wikiEntry.category || "").toLowerCase();
    if ((wikiCategory === "initiatives" || wikiCategory === "initiative") && wikiEntry.id === initiative.id) {
      return {
        success: true,
        selfLink: true,
        skipped: "own-compiled-page",
        bidirectional: false,
        initiativeId: args.initiativeId,
        wikiSlug
      };
    }
    let initiativeChanged = false;
    try {
      initiativeChanged = this.context.initiatives.addRelatedWikiLink(fileName, wikiSlug);
    } catch (err) {
      return { success: false, bidirectional: false, error: `wiki.link failed on initiative side: ${err.message || String(err)}` };
    }
    try {
      this.context.wiki.addRelatedInitiativeByRef(wikiSlug, args.initiativeId);
    } catch (err) {
      let rolledBack = false;
      if (initiativeChanged) {
        try {
          this.context.initiatives.removeRelatedWikiLink(fileName, wikiSlug);
          rolledBack = true;
        } catch {
        }
      }
      return {
        success: false,
        bidirectional: false,
        error: `wiki.link failed on wiki side: ${err.message || String(err)}`,
        rolledBack
      };
    }
    const initiativeAfter = this.context.initiatives.read(fileName);
    const wikiAfter = this.context.wiki.readByRef(wikiSlug);
    const initiativeLinked = !!initiativeAfter?.relatedWiki.includes(wikiSlug);
    const wikiLinked = !!wikiAfter?.relatedInitiatives.includes(args.initiativeId);
    if (initiativeLinked && wikiLinked) {
      return { success: true, bidirectional: true, initiativeId: args.initiativeId, wikiSlug };
    }
    if (initiativeLinked && !wikiLinked) {
      try {
        this.context.initiatives.removeRelatedWikiLink(fileName, wikiSlug);
      } catch {
      }
    }
    return {
      success: false,
      bidirectional: false,
      error: "wiki.link postcondition failed: link not persisted on both sides",
      initiativeLinked,
      wikiLinked
    };
  }
  crossReferenceWiki(args) {
    if (!args.fromSlug || !args.toSlug) return { error: "wiki.xref requires fromSlug and toSlug" };
    const parseCategoryRef = (ref) => {
      if (typeof ref !== "string") return null;
      const parts = ref.split("/");
      return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
    };
    const fromRef = parseCategoryRef(args.fromSlug);
    const toRef = parseCategoryRef(args.toSlug);
    if (!fromRef) return { success: false, error: `Invalid fromSlug format: ${args.fromSlug}. Expected category/id` };
    if (!toRef) return { success: false, error: `Invalid toSlug format: ${args.toSlug}. Expected category/id` };
    const [fromCategory, fromId] = fromRef;
    const [toCategory, toId] = toRef;
    if (!this.context.wiki.read(toCategory, toId)) {
      return { success: false, error: `Wiki target not found: ${args.toSlug}` };
    }
    this.context.wiki.addWikiCrossRef(fromCategory, fromId, toCategory, toId);
    const from = this.context.wiki.read(fromCategory, fromId);
    const persisted = !!from?.relatedWiki?.includes(`${toCategory}/${toId}`);
    return persisted ? { success: true, bidirectional: false, fromSlug: args.fromSlug, toSlug: args.toSlug } : { success: false, bidirectional: false, error: "wiki.xref postcondition failed: reference not persisted", fromSlug: args.fromSlug, toSlug: args.toSlug };
  }
  /**
   * wiki.ingest — record caller-supplied operations and apply them as one
   * isolated multi-file write composed from existing wiki.* primitives plus the
   * updateOverviewSection/appendLog helpers, wrapped in withLock.
   *
   * INVARIANT: ingest NEVER auto-generates prose. It only records + applies
   * exactly what the caller supplies (the agent authors all text). The manifest
   * contains only caller-supplied data + structural metadata (counts, refs,
   * ok/error).
   *
   * Best-effort batch: isolation is provided by the lock, NOT transactional
   * rollback — each op is wrapped in its own try/catch so one failing op records
   * an error but does NOT abort the rest of the batch.
   */
  ingestWiki(args) {
    const operations = args.operations;
    if (!Array.isArray(operations) || operations.length === 0) {
      return { error: "wiki.ingest requires { operations: WikiIngestOp[] }" };
    }
    const lockResult = withLock(this.context.mdocsRoot, "wiki-ingest", () => {
      const appliedOps2 = [];
      const changedFiles2 = [];
      for (const rawOp of operations) {
        const op = normalizeCommandKeys(rawOp);
        try {
          if (op.type === "createPage") {
            const category = op.category || "";
            const ref = category ? `${category}/${op.id}` : op.id;
            const filePath = this.context.wiki.create({
              category,
              id: op.id,
              title: op.title,
              created: today(),
              updated: today(),
              content: op.content ?? "",
              relatedInitiatives: Array.isArray(op.relatedInitiatives) ? op.relatedInitiatives : [],
              tags: Array.isArray(op.tags) ? op.tags : [],
              status: op.status,
              lifecycle: op.lifecycle,
              knowledgeType: op.knowledgeType,
              confidence: op.confidence
            });
            appliedOps2.push({ type: op.type, ref, ok: true });
            changedFiles2.push(path6.relative(this.context.mdocsRoot, filePath));
          } else if (op.type === "updatePage") {
            const category = op.category || "";
            const ref = category ? `${category}/${op.id}` : op.id;
            const existing = category ? this.context.wiki.read(category, op.id) : this.context.wiki.readByRef(op.id);
            if (!existing) {
              appliedOps2.push({ type: op.type, ref, ok: false, error: "not found" });
            } else {
              const rawIdentity = {
                id: existing.rawFrontmatter?.values.id,
                category: existing.rawFrontmatter?.values.category
              };
              const KNOWN_OP_KEYS = /* @__PURE__ */ new Set(["type", "category", "id", "content", "status", "lifecycle", "tags", "relatedInitiatives"]);
              const unsupportedFields = Object.keys(op).filter((key) => op[key] !== void 0 && !KNOWN_OP_KEYS.has(key));
              if (unsupportedFields.length > 0) {
                appliedOps2.push({
                  type: op.type,
                  ref,
                  ok: false,
                  error: `unsupported fields: ${unsupportedFields.join(", ")}`,
                  unsupportedFields
                });
                continue;
              }
              const appliedFields = [];
              const appliedValues = {};
              const applyOp = (field, value) => {
                existing[field] = value;
                appliedFields.push(field);
                appliedValues[field] = value;
              };
              if (op.content !== void 0) applyOp("content", op.content);
              if (op.status !== void 0) applyOp("status", op.status);
              if (op.lifecycle !== void 0) applyOp("lifecycle", op.lifecycle);
              if (Array.isArray(op.tags)) applyOp("tags", op.tags);
              if (Array.isArray(op.relatedInitiatives)) applyOp("relatedInitiatives", op.relatedInitiatives);
              const filePath = this.context.wiki.update(category, op.id, existing);
              const after = category ? this.context.wiki.read(category, op.id) : this.context.wiki.readByRef(op.id);
              const failedFields = appliedFields.filter((field) => {
                const actual = after?.[field];
                const expected = appliedValues[field];
                if (field === "content") return String(actual ?? "").trim() !== String(expected ?? "").trim();
                return !fieldsPersistedEqual(actual, expected);
              });
              if (!fieldsPersistedEqual(after?.rawFrontmatter?.values.id, rawIdentity.id) || !fieldsPersistedEqual(after?.rawFrontmatter?.values.category, rawIdentity.category)) {
                failedFields.push("raw identity/category");
              }
              if (failedFields.length > 0) {
                appliedOps2.push({
                  type: op.type,
                  ref,
                  ok: false,
                  error: `postcondition failed: fields not persisted: ${failedFields.join(", ")}`,
                  failedFields,
                  appliedFields: appliedFields.filter((field) => !failedFields.includes(field)),
                  unsupportedFields
                });
              } else {
                appliedOps2.push({ type: op.type, ref, ok: true, appliedFields });
                changedFiles2.push(path6.relative(this.context.mdocsRoot, filePath));
              }
            }
          } else if (op.type === "updateOverviewSection") {
            const filePath = this.context.wiki.updateOverviewSection(op.section, op.body);
            if (filePath === null) {
              appliedOps2.push({ type: op.type, ref: `overview#${op.section}`, ok: true, skipped: "non-directory-v2" });
            } else {
              appliedOps2.push({ type: op.type, ref: `overview#${op.section}`, ok: true });
              changedFiles2.push(path6.relative(this.context.mdocsRoot, filePath));
            }
          } else if (op.type === "appendLog") {
            const filePath = this.context.wiki.appendLog(op.entry);
            if (filePath === null) {
              appliedOps2.push({ type: op.type, ref: "log", ok: true, skipped: "non-directory-v2" });
            } else {
              appliedOps2.push({ type: op.type, ref: "log", ok: true });
              changedFiles2.push(path6.relative(this.context.mdocsRoot, filePath));
            }
          } else if (op.type === "link") {
            try {
              const target = this.context.wiki.readByRef(op.wikiSlug);
              const targetCategory = (target?.category || "").toLowerCase();
              if (target && (targetCategory === "initiatives" || targetCategory === "initiative") && target.id === op.initiativeId) {
                appliedOps2.push({ type: op.type, ref: `${op.initiativeId}->${op.wikiSlug}`, ok: true, selfLink: true, skipped: "own-compiled-page" });
              } else {
                this.context.wiki.addRelatedInitiativeByRef(op.wikiSlug, op.initiativeId);
                appliedOps2.push({ type: op.type, ref: `${op.initiativeId}->${op.wikiSlug}`, ok: true });
              }
            } catch (linkErr) {
              appliedOps2.push({ type: op.type, ref: `${op.initiativeId}->${op.wikiSlug}`, ok: false, error: linkErr.message || String(linkErr) });
            }
          } else {
            appliedOps2.push({ type: String(op.type), ref: "", ok: false, error: `unknown op type` });
          }
        } catch (opErr) {
          appliedOps2.push({ type: String(op.type), ref: "", ok: false, error: opErr.message || String(opErr) });
        }
      }
      return { appliedOps: appliedOps2, changedFiles: changedFiles2 };
    });
    if (!lockResult.ran || lockResult.value === void 0) {
      return { success: false, error: "wiki-ingest lock timeout" };
    }
    const { appliedOps, changedFiles } = lockResult.value;
    return {
      success: appliedOps.every((operation) => operation.ok),
      applied: appliedOps.length,
      operations: appliedOps,
      changedFiles,
      note: args.note ?? null
    };
  }
  syncIndex() {
    const regenerated = [
      path6.relative(this.context.mdocsRoot, this.context.initiatives.syncIndex()),
      ...this.context.wiki.syncIndices().map((filePath) => path6.relative(this.context.mdocsRoot, filePath))
    ];
    return { success: true, regenerated };
  }
};

// src/core/contract.ts
var fs6 = __toESM(require("fs"));
var path7 = __toESM(require("path"));
function safeExists(filePath) {
  try {
    return fs6.existsSync(filePath);
  } catch {
    return false;
  }
}
function isValidOwnerForMode(owner, mode) {
  if (owner === "harness") return mode === "generated-uppercase" || mode === "canonical-lowercase";
  if (owner === "external") return mode === "canonical-lowercase";
  if (owner === "none") return mode === "none";
  return false;
}
function hasExactChild(parentDir, childName) {
  if (!safeExists(parentDir)) return false;
  try {
    return fs6.readdirSync(parentDir).includes(childName);
  } catch {
    return false;
  }
}
function hasDirectoryInitiatives(initiativesDir) {
  if (!safeExists(initiativesDir)) return false;
  try {
    return fs6.readdirSync(initiativesDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory() || entry.name === "archive" || entry.name === "_archive") return false;
      return safeExists(path7.join(initiativesDir, entry.name, "_status.md"));
    });
  } catch {
    return false;
  }
}
function hasFlatInitiatives(initiativesDir) {
  if (!safeExists(initiativesDir)) return false;
  try {
    return fs6.readdirSync(initiativesDir).some((file) => file.endsWith(".md") && file !== "INDEX.md");
  } catch {
    return false;
  }
}
function schemaMentionsDirectoryStatus(mdocsRoot) {
  const schemaPath = path7.join(mdocsRoot, "SCHEMA.md");
  if (!safeExists(schemaPath)) return false;
  try {
    return fs6.readFileSync(schemaPath, "utf8").includes("_status.md");
  } catch {
    return false;
  }
}
function detectMdocsContract(mdocsRoot, config = {}) {
  const initiativesDir = path7.join(mdocsRoot, "initiatives");
  const wikiDir = path7.join(mdocsRoot, "wiki");
  const directorySignals = hasDirectoryInitiatives(initiativesDir) || schemaMentionsDirectoryStatus(mdocsRoot);
  const lowercaseWikiIndex = hasExactChild(wikiDir, "index.md");
  const uppercaseWikiIndex = hasExactChild(wikiDir, "INDEX.md");
  const underscoreArchive = safeExists(path7.join(initiativesDir, "_archive"));
  const flatInitiatives = hasFlatInitiatives(initiativesDir);
  const obsidianDir = path7.join(mdocsRoot, "_obsidian");
  const obsidianVisibilityLayer = safeExists(obsidianDir) && isDirectory(obsidianDir);
  const initiativeMode = config.initiativeMode && config.initiativeMode !== "auto" ? config.initiativeMode : directorySignals ? "directory" : "flat";
  const wikiIndexMode = config.wikiIndexMode && config.wikiIndexMode !== "auto" ? config.wikiIndexMode : directorySignals ? lowercaseWikiIndex ? "canonical-lowercase" : "none" : lowercaseWikiIndex && !uppercaseWikiIndex ? "canonical-lowercase" : "generated-uppercase";
  const archiveDir = config.archiveDir && config.archiveDir !== "auto" ? config.archiveDir : underscoreArchive ? "_archive" : "archive";
  const legacyFlatFiles = config.legacyFlatFiles === "auto" || config.legacyFlatFiles === void 0 ? flatInitiatives : config.legacyFlatFiles;
  const defaultWikiIndexOwner = wikiIndexMode === "generated-uppercase" ? "harness" : wikiIndexMode === "canonical-lowercase" ? "external" : "none";
  const configuredOwner = config.wikiIndexOwner;
  const wikiIndexOwner = configuredOwner && isValidOwnerForMode(configuredOwner, wikiIndexMode) ? configuredOwner : defaultWikiIndexOwner;
  return {
    initiativeMode,
    wikiIndexMode,
    archiveDir,
    legacyFlatFiles,
    wikiIndexOwner,
    obsidianVisibilityLayer,
    obsidianDir: obsidianVisibilityLayer ? obsidianDir : void 0,
    obsidianRefreshCommand: config.obsidianRefreshCommand ?? null,
    enforcementMode: resolveEnforcementMode(config.enforcementMode),
    idle: resolveIdleStrictness(config.idle),
    initiativeRecordMode: config.initiativeRecordMode ?? "full"
  };
}
function resolveEnforcementMode(configValue) {
  const envValue = typeof process !== "undefined" && process.env?.MDOCS_ENFORCEMENT;
  if (envValue === "gate" || envValue === "advisory" || envValue === "off") return envValue;
  return configValue ?? "gate";
}
function resolveIdleStrictness(configValue) {
  const envValue = typeof process !== "undefined" && process.env?.MDOCS_ENFORCEMENT_IDLE;
  if (envValue === "readonly" || envValue === "open") return envValue;
  return configValue ?? "open";
}
function isDirectory(filePath) {
  try {
    return fs6.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

// src/core/lifecycle.ts
var MdocsLifecycleService = class {
  constructor(mdocs, initiatives, options = {}) {
    this.mdocs = mdocs;
    this.initiatives = initiatives;
    this.options = options;
  }
  mdocs;
  initiatives;
  options;
  ensureInitialized() {
    if (this.mdocs.exists()) {
      return { initialized: false, bootstrapInitiativeCreated: false };
    }
    const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    this.mdocs.init();
    if (this.options.createInstallInitiative === false) {
      return { initialized: true, bootstrapInitiativeCreated: false };
    }
    this.initiatives.create({
      id: this.options.installInitiativeId || "install-mdocs",
      title: this.options.installInitiativeTitle || "Install and Configure mdocs",
      status: "active",
      created: date,
      updated: date,
      owner: this.options.owner || "system",
      tags: this.options.tags || ["setup", "plugin"],
      relatedWiki: [],
      objective: "Install and configure mdocs for this project",
      plan: [
        { description: "Install package", status: "pending" },
        { description: "Configure harness adapter", status: "pending" },
        { description: "Verify workflow", status: "pending" }
      ],
      progressLog: ["Mdocs initialized"],
      artifacts: []
    });
    return { initialized: true, bootstrapInitiativeCreated: true };
  }
};

// src/core/managers/initiative.ts
var fs8 = __toESM(require("fs"));
var path9 = __toESM(require("path"));

// src/core/initiative-store.ts
var fs7 = __toESM(require("fs"));
var path8 = __toESM(require("path"));
var METADATA_ONLY_CORE_LIFECYCLE_KEYS = /* @__PURE__ */ new Set([
  "status",
  "updated",
  "completed",
  "graduated"
]);
var METADATA_ONLY_OPTIONAL_LIFECYCLE_KEYS = /* @__PURE__ */ new Set([
  "next_action"
]);
function parseSection(content, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match ? match[1].trim() : "";
}
function parseListSection(content, sectionName) {
  const section = parseSection(content, sectionName);
  return section.split("\n").filter((line) => line.trim().startsWith("- ")).map((line) => line.replace(/^- /, "").trim());
}
function parsePlanItem(line) {
  const checkableMatch = line.match(/^- \[([ x/])\]\s*(.+)$/);
  if (checkableMatch) {
    const mark = checkableMatch[1];
    return { description: checkableMatch[2].trim(), status: mark === "x" ? "done" : mark === "/" ? "in-progress" : "pending" };
  }
  const plainMatch = line.match(/^- \s*(.+)$/);
  return { description: (plainMatch?.[1] || line).trim(), status: "pending" };
}
function parsePlanSection(content) {
  const section = parseSection(content, "Plan");
  return section.split("\n").filter((line) => line.trim().startsWith("- ")).map((line) => parsePlanItem(line));
}
function titleize(slug) {
  return slug.split(/[-_]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function normalizeInitiativeStatus(status) {
  const value = (status || "active").toLowerCase();
  if (["complete", "completed"].includes(value)) return "complete";
  if (value === "done") return "done";
  if (["archived", "archive"].includes(value)) return "archived";
  if (["paused", "blocked", "hold", "on-hold", "on_hold"].includes(value)) return "paused";
  return "active";
}
var ALLOWED_EXPECTED_DURATIONS = /* @__PURE__ */ new Set(["normal", "long", "suppress"]);
function coerceExpectedDuration(raw) {
  if (typeof raw !== "string") return void 0;
  const value = raw.toLowerCase();
  return ALLOWED_EXPECTED_DURATIONS.has(value) ? value : void 0;
}
var InitiativeStore = class {
  constructor(baseDir, contract) {
    this.baseDir = baseDir;
    this.contract = contract;
    this.initiativesDir = path8.join(baseDir, "initiatives");
  }
  baseDir;
  contract;
  initiativesDir;
  list(options = {}) {
    const records = [];
    if (!fs7.existsSync(this.initiativesDir)) return records;
    if (this.contract.initiativeMode === "directory") {
      records.push(...this.listDirectoryRecords(false));
      if (options.includeArchived) records.push(...this.listDirectoryRecords(true));
      if (this.contract.legacyFlatFiles) records.push(...this.listFlatRecords());
      return records;
    }
    return this.listFlatRecords();
  }
  read(key) {
    return this.list({ includeArchived: true }).find((record) => record.key === key || record.initiative.id === key) || null;
  }
  create(initiative) {
    const key = this.safeDirectoryKey(slugify2(initiative.id || initiative.title));
    if (this.findById(initiative.id, { includeArchived: true }) || this.read(key)) {
      throw new Error(`Initiative already exists: ${initiative.id || key}`);
    }
    const dirPath = path8.join(this.initiativesDir, key);
    const filePath = path8.join(dirPath, "_status.md");
    if (fs7.existsSync(dirPath)) throw new Error(`Initiative directory already exists: ${key}`);
    fs7.mkdirSync(dirPath, { recursive: true });
    fs7.writeFileSync(filePath, this.formatStatusFile(initiative), "utf8");
    const record = this.read(key);
    if (!record) throw new Error(`Directory initiative not found after create: ${key}`);
    return { key, dirPath, filePath, initiative: record.initiative };
  }
  update(key, initiative, progressNote) {
    const record = this.read(key);
    if (!record || record.sourceKind !== "directory-status" || record.archived) {
      throw new Error(`Directory initiative not found: ${key}`);
    }
    const duplicate = this.findById(initiative.id, { includeArchived: true });
    if (duplicate && duplicate.key !== record.key) throw new Error(`Duplicate initiative id "${initiative.id}" found in ${duplicate.key}`);
    this.updateStatusFile(record.filePath, this.frontmatterUpdates(initiative), progressNote);
    const updated = this.read(record.key);
    if (!updated) throw new Error(`Directory initiative not found after update: ${key}`);
    return { key: record.key, dirPath: path8.dirname(record.filePath), filePath: record.filePath, initiative: updated.initiative };
  }
  delete(key) {
    const record = this.read(key);
    if (!record || record.sourceKind !== "directory-status" || record.archived) {
      throw new Error(`Directory initiative not found: ${key}`);
    }
    const slug = this.safeDirectoryKey(record.key);
    const dirPath = path8.join(this.initiativesDir, slug);
    if (!fs7.existsSync(dirPath)) throw new Error(`Directory initiative not found: ${key}`);
    fs7.rmSync(dirPath, { recursive: true, force: false });
  }
  markDone(key, timestamp = /* @__PURE__ */ new Date()) {
    const record = this.read(key);
    if (!record || record.sourceKind !== "directory-status" || record.archived) {
      throw new Error(`Directory initiative not found: ${key}`);
    }
    const date = timestamp.toISOString().split("T")[0];
    this.updateStatusFile(record.filePath, {
      status: "complete",
      updated: date,
      completed: record.rawFrontmatter.completed || date
    }, `[${timestamp.toISOString()}] Marked done via mdocs command`);
    const updated = this.read(record.key);
    if (!updated) throw new Error(`Directory initiative not found after update: ${key}`);
    return { key: record.key, filePath: record.filePath, initiative: updated.initiative };
  }
  archive(key) {
    const record = this.read(key);
    if (!record || record.sourceKind !== "directory-status" || record.archived) {
      throw new Error(`Directory initiative not found: ${key}`);
    }
    if (!isCompleted(record.initiative.status)) throw new Error(`Only completed initiatives can be archived: ${record.initiative.id}`);
    const slug = this.safeDirectoryKey(record.key);
    const sourcePath = path8.join(this.initiativesDir, slug);
    const archiveDir = path8.join(this.initiativesDir, "_archive");
    const targetPath = path8.join(archiveDir, slug);
    if (!fs7.existsSync(sourcePath)) throw new Error(`Directory initiative not found: ${key}`);
    if (fs7.existsSync(targetPath)) throw new Error(`Archived initiative already exists: ${slug}`);
    fs7.mkdirSync(archiveDir, { recursive: true });
    this.updateStatusFile(record.filePath, {
      status: "archived",
      updated: (/* @__PURE__ */ new Date()).toISOString().split("T")[0]
    });
    fs7.renameSync(sourcePath, targetPath);
    return { archivedFilename: slug, sourcePath, targetPath };
  }
  findById(id, options = {}) {
    return this.list(options).find((record) => record.initiative.id === id) || null;
  }
  findByReference(query, options = {}) {
    const querySlug = slugify2(query);
    const records = this.list(options);
    const exact = records.find((record) => {
      const initiative = record.initiative;
      const keySlug = slugify2(record.key.replace(/\.md$/, "").replace(/--\d{4}-\d{2}-\d{2}$/, ""));
      const idSlug = slugify2(initiative.id || "");
      return initiative.id === query || idSlug === querySlug || record.key === query || keySlug === querySlug;
    });
    if (exact) return exact;
    return records.find((record) => {
      const aliases = Array.isArray(record.rawFrontmatter.aliases) ? record.rawFrontmatter.aliases : record.initiative.aliases || [];
      const aliasSlugs = aliases.map((alias) => slugify2(alias));
      return aliases.includes(query) || aliasSlugs.includes(querySlug);
    }) || null;
  }
  findByQuery(query) {
    const normalizedQuery = query.toLowerCase();
    const querySlug = slugify2(query);
    return this.list({ includeArchived: true }).find((record) => {
      const initiative = record.initiative;
      const keySlug = slugify2(record.key.replace(/\.md$/, "").replace(/--\d{4}-\d{2}-\d{2}$/, ""));
      const idSlug = slugify2(initiative.id || "");
      const titleSlug = slugify2(initiative.title || "");
      const aliasSlugs = (initiative.aliases || []).map((alias) => slugify2(alias));
      return initiative.id === query || idSlug === querySlug || (initiative.aliases || []).includes(query) || aliasSlugs.includes(querySlug) || initiative.title.toLowerCase().includes(normalizedQuery) || titleSlug === querySlug || record.key === query || keySlug === querySlug;
    }) || null;
  }
  listFlatRecords() {
    if (!fs7.existsSync(this.initiativesDir)) return [];
    return fs7.readdirSync(this.initiativesDir).filter((file) => file.endsWith(".md") && file !== "INDEX.md").flatMap((file) => {
      const filePath = path8.join(this.initiativesDir, file);
      try {
        return [this.parseRecord(file, filePath, "flat-file", false, file.replace(/\.md$/, ""))];
      } catch {
        return [];
      }
    });
  }
  listDirectoryRecords(archived) {
    const parent = archived ? path8.join(this.initiativesDir, "_archive") : this.initiativesDir;
    if (!fs7.existsSync(parent)) return [];
    return fs7.readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "archive" && entry.name !== "_archive").flatMap((entry) => {
      const statusPath = path8.join(parent, entry.name, "_status.md");
      if (!fs7.existsSync(statusPath)) return [];
      try {
        const key = archived ? `_archive/${entry.name}` : entry.name;
        return [this.parseRecord(key, statusPath, "directory-status", archived, entry.name)];
      } catch {
        return [];
      }
    });
  }
  parseRecord(key, filePath, sourceKind, archived, slug) {
    const content = fs7.readFileSync(filePath, "utf8");
    const front = parseFrontmatter(content);
    if (!Object.keys(front).length) throw new Error(`Invalid initiative format: ${key}`);
    const body = content.replace(/---\r?\n[\s\S]*?\r?\n---/, "").trim();
    const objective = parseSection(body, "Objective") || body;
    const created = front.created || front.started || "";
    const initiative = {
      id: front.id || slug,
      title: front.title || titleize(slug),
      status: normalizeInitiativeStatus(front.status),
      priority: front.priority || "medium",
      created,
      updated: front.updated || front.modified || created,
      owner: front.owner || "",
      tags: Array.isArray(front.tags) ? front.tags : [],
      aliases: Array.isArray(front.aliases) ? front.aliases : [],
      relatedWiki: Array.isArray(front.related_wiki) ? front.related_wiki : [],
      objective,
      plan: parsePlanSection(body),
      progressLog: parseListSection(body, "Progress Log"),
      artifacts: parseListSection(body, "Artifacts"),
      dueDate: front.due_date || void 0,
      dependsOn: Array.isArray(front.depends_on) ? front.depends_on : void 0,
      phase: front.phase || void 0,
      handoffSummary: front.handoff_summary || void 0,
      openQuestions: Array.isArray(front.open_questions) ? front.open_questions : void 0,
      blockers: Array.isArray(front.blockers) ? front.blockers : void 0,
      nextAction: front.next_action || void 0,
      expectedDuration: coerceExpectedDuration(readExpectedDurationRaw(front)),
      graduated: front.graduated || void 0
    };
    return { key, filePath, sourceKind, archived, rawFrontmatter: front, initiative };
  }
  formatStatusFile(initiative) {
    const front = this.frontmatterUpdates(initiative);
    const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`);
    const sections = [
      initiative.objective ? `## Objective
${initiative.objective}` : "",
      initiative.plan.length ? `## Plan
${initiative.plan.map((item) => `- [${item.status === "done" ? "x" : item.status === "in-progress" ? "/" : " "}] ${item.description}`).join("\n")}` : "",
      initiative.progressLog.length ? `## Progress Log
${initiative.progressLog.map((item) => `- ${item}`).join("\n")}` : "",
      initiative.artifacts.length ? `## Artifacts
${initiative.artifacts.map((item) => `- ${item}`).join("\n")}` : ""
    ].filter(Boolean).join("\n\n");
    return `---
${lines.join("\n")}
---

${sections}
`;
  }
  frontmatterUpdates(initiative) {
    const status = isCompleted(initiative.status) ? "complete" : initiative.status;
    const front = {
      id: initiative.id,
      title: initiative.title,
      status,
      started: initiative.created,
      updated: initiative.updated || (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
      owner: initiative.owner || "",
      tags: JSON.stringify(initiative.tags || []),
      related_wiki: JSON.stringify(initiative.relatedWiki || [])
    };
    if (initiative.priority) front.priority = initiative.priority;
    front.aliases = JSON.stringify(initiative.aliases || []);
    if (initiative.dueDate) front.due_date = initiative.dueDate;
    if (initiative.dependsOn) front.depends_on = JSON.stringify(initiative.dependsOn);
    if (initiative.phase) front.phase = initiative.phase;
    if (initiative.handoffSummary) front.handoff_summary = initiative.handoffSummary;
    if (initiative.openQuestions) front.open_questions = JSON.stringify(initiative.openQuestions);
    if (initiative.blockers) front.blockers = JSON.stringify(initiative.blockers);
    if (initiative.nextAction) front.next_action = initiative.nextAction;
    if (initiative.expectedDuration) front.expected_duration = initiative.expectedDuration;
    if (initiative.graduated) front.graduated = initiative.graduated;
    return front;
  }
  safeDirectoryKey(key) {
    const base = path8.basename(key);
    if (!base || base === "." || base === ".." || base !== key || key.includes("/") || key.includes("\\")) {
      throw new Error(`Invalid directory initiative key: ${key}`);
    }
    return base;
  }
  updateStatusFile(filePath, updates, progressNote) {
    const content = fs7.readFileSync(filePath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)([\s\S]*)$/);
    if (!match) throw new Error(`Invalid initiative status format: ${filePath}`);
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = match[1].split(/\r?\n/);
    if (this.contract.initiativeRecordMode === "metadata-only") {
      for (const [key, value] of Object.entries(updates)) {
        const isCore = METADATA_ONLY_CORE_LIFECYCLE_KEYS.has(key);
        if (!isCore && !METADATA_ONLY_OPTIONAL_LIFECYCLE_KEYS.has(key)) continue;
        const index = lines.findIndex((line) => line.match(new RegExp(`^${key}:`)));
        if (index >= 0) {
          lines[index] = `${key}: ${value}`;
        } else if (isCore) {
          lines.push(`${key}: ${value}`);
        }
      }
      const body2 = match[3] || "";
      fs7.writeFileSync(filePath, `---${newline}${lines.join(newline)}${newline}---${match[2]}${body2}`, "utf8");
      return;
    }
    for (const [key, value] of Object.entries(updates)) {
      const index = lines.findIndex((line) => line.match(new RegExp(`^${key}:`)));
      const nextLine = `${key}: ${value}`;
      if (index >= 0) lines[index] = nextLine;
      else lines.push(nextLine);
    }
    let body = match[3] || "";
    if (progressNote) body = this.appendProgressNote(body, progressNote, newline);
    fs7.writeFileSync(filePath, `---${newline}${lines.join(newline)}${newline}---${newline}${body.replace(/^\r?\n/, "")}`, "utf8");
  }
  /**
   * Surgical frontmatter-array mutation for explicit link operations. Adds or
   * removes one value in a named frontmatter array key (e.g. `related_wiki`)
   * by line-based rewrite, preserving the body and every other frontmatter
   * line byte-for-byte. Creates the key (JSON array form) when absent on add.
   * Idempotent: returns false when the array already contains (add) or does
   * not contain (remove) the value and leaves the file untouched.
   *
   * Unlike updateStatusFile's metadata-only lifecycle path this MAY introduce
   * the named key: an explicit link operation is a structural mutation the
   * caller asked for, not a lifecycle refresh.
   */
  addFrontmatterArrayValue(key, arrayKey, value) {
    return this.mutateFrontmatterArrayForKey(key, arrayKey, value, "add");
  }
  removeFrontmatterArrayValue(key, arrayKey, value) {
    return this.mutateFrontmatterArrayForKey(key, arrayKey, value, "remove");
  }
  mutateFrontmatterArrayForKey(key, arrayKey, value, op) {
    const record = this.read(key);
    if (!record || record.sourceKind !== "directory-status" || record.archived) {
      throw new Error(`Directory initiative not found: ${key}`);
    }
    return this.mutateFrontmatterArray(record.filePath, arrayKey, value, op);
  }
  mutateFrontmatterArray(filePath, arrayKey, value, op) {
    const content = fs7.readFileSync(filePath, "utf8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)([\s\S]*)$/);
    if (!match) throw new Error(`Invalid initiative status format: ${filePath}`);
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = match[1].split(/\r?\n/);
    const index = lines.findIndex((line) => line.match(new RegExp(`^${arrayKey}:`)));
    let current = [];
    let inlineYaml = false;
    if (index >= 0) {
      const rawValue = lines[index].slice(lines[index].indexOf(":") + 1).trim();
      const parsed = parseYamlValue(rawValue);
      current = Array.isArray(parsed) ? parsed.map(String) : [];
      inlineYaml = rawValue.startsWith("[") && !rawValue.includes('"');
    }
    const changed = op === "add" ? !current.includes(value) : current.includes(value);
    if (!changed) return false;
    const next = op === "add" ? [...current, value] : current.filter((item) => item !== value);
    if (op === "remove" && next.length === 0 && index >= 0) {
      lines.splice(index, 1);
    } else {
      const nextLine = inlineYaml ? `${arrayKey}: [${next.join(", ")}]` : `${arrayKey}: ${JSON.stringify(next)}`;
      if (index >= 0) lines[index] = nextLine;
      else lines.push(nextLine);
    }
    const body = match[3] || "";
    fs7.writeFileSync(filePath, `---${newline}${lines.join(newline)}${newline}---${match[2]}${body}`, "utf8");
    return true;
  }
  appendProgressNote(body, progressNote, newline) {
    const noteLine = `- ${progressNote}`;
    if (/## Progress Log\r?\n/.test(body)) {
      return body.replace(/(## Progress Log\r?\n)/, `$1${noteLine}${newline}`);
    }
    const separator = body.trim().length > 0 ? `${newline}${newline}` : "";
    return `${body.replace(/\s*$/, "")}${separator}## Progress Log${newline}${noteLine}${newline}`;
  }
};
function slugify2(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// src/core/managers/initiative.ts
function parseSection2(content, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match ? match[1].trim() : "";
}
function parseListSection2(content, sectionName) {
  const section = parseSection2(content, sectionName);
  return section.split("\n").filter((line) => line.trim().startsWith("- ")).map((line) => line.replace(/^- /, "").trim());
}
function formatPlanItem(item) {
  const statusMap = {
    "pending": "- [ ]",
    "in-progress": "- [/]",
    "done": "- [x]"
  };
  const prefix = statusMap[item.status] || "- [ ]";
  return `${prefix} ${item.description}`;
}
function parsePlanItem2(line) {
  const checkableMatch = line.match(/^- \[([ x/])\]\s*(.+)$/);
  if (checkableMatch) {
    const mark = checkableMatch[1];
    const description = checkableMatch[2].trim();
    const status = mark === "x" ? "done" : mark === "/" ? "in-progress" : "pending";
    return { description, status };
  }
  const plainMatch = line.match(/^- \s*(.+)$/);
  if (plainMatch) {
    return { description: plainMatch[1].trim(), status: "pending" };
  }
  return { description: line.trim(), status: "pending" };
}
function parsePlanSection2(content) {
  const section = parseSection2(content, "Plan");
  return section.split("\n").filter((line) => line.trim().startsWith("- ")).map((line) => parsePlanItem2(line));
}
var ALLOWED_EXPECTED_DURATIONS2 = /* @__PURE__ */ new Set(["normal", "long", "suppress"]);
function coerceExpectedDuration2(raw) {
  if (typeof raw !== "string") return void 0;
  const value = raw.toLowerCase();
  return ALLOWED_EXPECTED_DURATIONS2.has(value) ? value : void 0;
}
function isSafePathSegment(segment) {
  return !!segment && segment !== "." && segment !== ".." && path9.basename(segment) === segment;
}
var InitiativeManager = class {
  dir;
  contract;
  store;
  constructor(baseDir, options = {}) {
    this.dir = path9.join(baseDir, "initiatives");
    this.contract = detectMdocsContract(baseDir, options.compatibility);
    this.store = new InitiativeStore(baseDir, this.contract);
    fs8.mkdirSync(this.dir, { recursive: true });
  }
  slugify(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  formatFileName(initiative) {
    const idSlug = this.slugify(initiative.id || "");
    const slug = idSlug || this.slugify(initiative.title);
    return `${slug}--${initiative.created}.md`;
  }
  sanitizeFileName(fileName) {
    const base = path9.basename(fileName);
    if (!base || base === "." || base === "..") {
      return "invalid.md";
    }
    return base;
  }
  toFrontmatter(initiative) {
    const front = {
      id: initiative.id,
      title: initiative.title,
      status: initiative.status,
      created: initiative.created,
      updated: initiative.updated,
      owner: initiative.owner,
      tags: initiative.tags,
      ...initiative.aliases && initiative.aliases.length > 0 ? { aliases: initiative.aliases } : {},
      related_wiki: initiative.relatedWiki
    };
    if (initiative.priority) {
      front.priority = initiative.priority;
    }
    if (initiative.dueDate) {
      front.due_date = initiative.dueDate;
    }
    if (initiative.dependsOn && initiative.dependsOn.length > 0) {
      front.depends_on = initiative.dependsOn;
    }
    if (initiative.phase) front.phase = initiative.phase;
    if (initiative.handoffSummary) front.handoff_summary = initiative.handoffSummary;
    if (initiative.openQuestions && initiative.openQuestions.length > 0) front.open_questions = initiative.openQuestions;
    if (initiative.blockers && initiative.blockers.length > 0) front.blockers = initiative.blockers;
    if (initiative.nextAction) front.next_action = initiative.nextAction;
    if (initiative.expectedDuration) front.expected_duration = initiative.expectedDuration;
    if (initiative.graduated) front.graduated = initiative.graduated;
    return `---
${Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}
---

`;
  }
  initiativeFiles() {
    return fs8.readdirSync(this.dir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
  }
  validationFiles() {
    if (this.contract.initiativeMode !== "directory") return this.initiativeFiles();
    return fs8.readdirSync(this.dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "archive" && entry.name !== "_archive").map((entry) => path9.join(entry.name, "_status.md")).filter((fileName) => fs8.existsSync(path9.join(this.dir, fileName)));
  }
  markdownDestinations(content) {
    const refs = /* @__PURE__ */ new Set();
    const addRef = (value) => {
      let ref = value.split(/[?#]/)[0].replace(/\\/g, "/");
      while (ref.startsWith("./")) ref = ref.slice(2);
      if (ref.endsWith(".md")) ref = ref.slice(0, -3);
      if (ref) refs.add(ref.replace(/\/$/, ""));
    };
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
      addRef(match[1]);
    }
    for (const match of content.matchAll(/`((?:\.\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\/)`/g)) {
      addRef(match[1]);
    }
    return refs;
  }
  listedIndexFiles(indexContent) {
    return new Set(indexContent.split(/\r?\n/).map((line) => line.match(/^-\s+\*\*.*\*\*\s+\([^)]*\)\s+—\s+([\w.-]+\.md)\s+—/)?.[1]).filter((name) => !!name && /^[\w.-]+\.md$/.test(name) && name !== "INDEX.md"));
  }
  assertUniqueId(id, ignoreFileName) {
    if (!id) return;
    const ignored = ignoreFileName ? path9.resolve(this.dir, this.sanitizeFileName(ignoreFileName)) : "";
    for (const fileName of this.initiativeFiles()) {
      if (ignored && path9.resolve(this.dir, fileName) === ignored) continue;
      try {
        const existing = this.read(fileName);
        if (existing?.id === id) {
          throw new Error(`Duplicate initiative id "${id}" found in ${fileName}`);
        }
      } catch (err) {
        if (err.message?.startsWith("Duplicate initiative id")) throw err;
      }
    }
  }
  assertWriteSupported(operation) {
    const directoryNativeWrites = /* @__PURE__ */ new Set(["initiative.create", "initiative.update", "initiative.done", "initiative.delete", "initiative.archive", "lifecycle.graduate", "wiki.link"]);
    if (this.contract.initiativeMode === "directory" && !directoryNativeWrites.has(operation)) {
      throw new Error(`${operation} is not supported for directory-v2 initiatives; write support is read-only to prevent accidental flat-file writes.`);
    }
  }
  create(initiative) {
    this.assertWriteSupported("initiative.create");
    if (this.contract.initiativeMode === "directory") {
      return this.store.create(initiative).dirPath;
    }
    const fileName = this.formatFileName(initiative);
    const filePath = path9.join(this.dir, fileName);
    if (fs8.existsSync(filePath)) {
      throw new Error(`Initiative file already exists: ${fileName}`);
    }
    this.assertUniqueId(initiative.id);
    const content = this.toFrontmatter(initiative) + `## Objective
${initiative.objective}

## Plan
${initiative.plan.map((p) => formatPlanItem(p)).join("\n")}

## Progress Log
${initiative.progressLog.map((l) => `- ${l}`).join("\n")}

## Artifacts
${initiative.artifacts.map((a) => `- ${a}`).join("\n")}`;
    fs8.writeFileSync(filePath, content, "utf8");
    this.updateIndex();
    return filePath;
  }
  read(fileName) {
    const sanitized = this.sanitizeFileName(fileName);
    const filePath = path9.join(this.dir, sanitized);
    if (!fs8.existsSync(filePath) || fs8.statSync(filePath).isDirectory()) {
      return this.contract.initiativeMode === "directory" ? this.store.read(fileName)?.initiative || null : null;
    }
    const content = fs8.readFileSync(filePath, "utf8");
    return this.parseInitiative(content, fileName);
  }
  parseInitiative(content, fileName) {
    const front = parseFrontmatter(content);
    if (!Object.keys(front).length) throw new Error(`Invalid initiative format: ${fileName}`);
    const body = content.replace(/---\n[\s\S]*?\n---/, "").trim();
    return {
      id: front.id || "",
      title: front.title || "",
      status: normalizeInitiativeStatus(front.status),
      priority: front.priority || "medium",
      created: front.created || "",
      updated: front.updated || "",
      owner: front.owner || "",
      tags: Array.isArray(front.tags) ? front.tags : [],
      aliases: Array.isArray(front.aliases) ? front.aliases : [],
      relatedWiki: Array.isArray(front.related_wiki) ? front.related_wiki : [],
      // Parse markdown sections
      objective: parseSection2(body, "Objective"),
      plan: parsePlanSection2(body),
      progressLog: parseListSection2(body, "Progress Log"),
      artifacts: parseListSection2(body, "Artifacts"),
      dueDate: front.due_date || void 0,
      dependsOn: Array.isArray(front.depends_on) ? front.depends_on : void 0,
      phase: front.phase || void 0,
      handoffSummary: front.handoff_summary || void 0,
      openQuestions: Array.isArray(front.open_questions) ? front.open_questions : void 0,
      blockers: Array.isArray(front.blockers) ? front.blockers : void 0,
      nextAction: front.next_action || void 0,
      expectedDuration: coerceExpectedDuration2(readExpectedDurationRaw(front)),
      graduated: front.graduated || void 0
    };
  }
  update(fileName, initiative) {
    this.assertWriteSupported("initiative.update");
    if (this.contract.initiativeMode === "directory") {
      const previous = this.store.read(fileName)?.initiative.progressLog || [];
      const newProgress = initiative.progressLog.slice(previous.length).join("\n- ");
      return this.store.update(fileName, initiative, newProgress || void 0).dirPath;
    }
    const sanitized = this.sanitizeFileName(fileName);
    this.assertUniqueId(initiative.id, sanitized);
    const oldPath = path9.join(this.dir, sanitized);
    const newFileName = this.formatFileName(initiative);
    const newPath = path9.join(this.dir, newFileName);
    if (oldPath !== newPath) {
      if (fs8.existsSync(newPath)) {
        throw new Error(`Cannot update: target file already exists: ${newFileName}`);
      }
      if (fs8.existsSync(oldPath)) {
        fs8.unlinkSync(oldPath);
      }
    }
    const content = this.toFrontmatter(initiative) + `## Objective
${initiative.objective}

## Plan
${initiative.plan.map((p) => formatPlanItem(p)).join("\n")}

## Progress Log
${initiative.progressLog.map((l) => `- ${l}`).join("\n")}

## Artifacts
${initiative.artifacts.map((a) => `- ${a}`).join("\n")}`;
    fs8.writeFileSync(newPath, content, "utf8");
    this.updateIndex();
    return newPath;
  }
  markDone(fileName) {
    if (this.contract.initiativeMode === "directory") {
      const result = this.store.markDone(fileName);
      return { filePath: result.filePath, filename: result.key, initiative: result.initiative };
    }
    const sanitized = this.sanitizeFileName(fileName);
    const initiative = this.read(sanitized);
    if (!initiative) throw new Error(`Initiative file not found: ${sanitized}`);
    initiative.status = "done";
    initiative.updated = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    initiative.progressLog.push(`[${(/* @__PURE__ */ new Date()).toISOString()}] Marked done via mdocs command`);
    const filePath = this.update(sanitized, initiative);
    return { filePath, filename: path9.basename(filePath), initiative };
  }
  delete(fileName) {
    this.assertWriteSupported("initiative.delete");
    if (this.contract.initiativeMode === "directory") {
      this.store.delete(fileName);
      return;
    }
    const sanitized = this.sanitizeFileName(fileName);
    const filePath = path9.join(this.dir, sanitized);
    if (fs8.existsSync(filePath)) {
      fs8.unlinkSync(filePath);
      this.updateIndex();
    }
  }
  syncIndex() {
    if (this.contract.initiativeMode === "directory") {
      return path9.join(this.dir, "INDEX.md");
    }
    this.updateIndex();
    return path9.join(this.dir, "INDEX.md");
  }
  archive(fileName) {
    this.assertWriteSupported("initiative.archive");
    if (this.contract.initiativeMode === "directory") {
      const result = this.store.archive(fileName);
      return { archivedFilename: result.archivedFilename, archiveIndex: path9.join(this.dir, "_archive") };
    }
    const sanitized = this.sanitizeFileName(fileName);
    const sourcePath = path9.join(this.dir, sanitized);
    if (!fs8.existsSync(sourcePath)) throw new Error(`Initiative file not found: ${sanitized}`);
    const initiative = this.read(sanitized);
    if (!initiative) throw new Error(`Initiative file not found: ${sanitized}`);
    if (!isCompleted(initiative.status)) throw new Error(`Only completed initiatives can be archived: ${initiative.id}`);
    const archiveDir = path9.join(this.dir, "archive");
    fs8.mkdirSync(archiveDir, { recursive: true });
    const targetPath = path9.join(archiveDir, sanitized);
    if (fs8.existsSync(targetPath)) throw new Error(`Archived initiative already exists: ${sanitized}`);
    fs8.renameSync(sourcePath, targetPath);
    this.updateIndex();
    this.updateArchiveIndex();
    return { archivedFilename: sanitized, archiveIndex: path9.join(archiveDir, "INDEX.md") };
  }
  /**
   * Add one wiki ref to the initiative's related_wiki. Under directory
   * metadata-only mode this is a surgical frontmatter-array mutation (body
   * and unrelated frontmatter preserved byte-for-byte, key created if
   * absent); every other mode routes through the standard full update.
   * Idempotent: returns false when the ref was already linked.
   */
  addRelatedWikiLink(fileName, ref) {
    if (this.contract.initiativeMode === "directory" && this.contract.initiativeRecordMode === "metadata-only") {
      return this.store.addFrontmatterArrayValue(fileName, "related_wiki", ref);
    }
    const initiative = this.read(fileName);
    if (!initiative) throw new Error(`Initiative file not found: ${fileName}`);
    if (initiative.relatedWiki.includes(ref)) return false;
    initiative.relatedWiki.push(ref);
    initiative.updated = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    this.update(fileName, initiative);
    return true;
  }
  /**
   * Remove one wiki ref from the initiative's related_wiki. Mirrors
   * addRelatedWikiLink; used to roll back failed bidirectional links.
   * Idempotent: returns false when the ref was not linked.
   */
  removeRelatedWikiLink(fileName, ref) {
    if (this.contract.initiativeMode === "directory" && this.contract.initiativeRecordMode === "metadata-only") {
      return this.store.removeFrontmatterArrayValue(fileName, "related_wiki", ref);
    }
    const initiative = this.read(fileName);
    if (!initiative) throw new Error(`Initiative file not found: ${fileName}`);
    if (!initiative.relatedWiki.includes(ref)) return false;
    initiative.relatedWiki = initiative.relatedWiki.filter((item) => item !== ref);
    initiative.updated = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    this.update(fileName, initiative);
    return true;
  }
  findById(id) {
    return this.store.findById(id)?.initiative || null;
  }
  findKeyById(id) {
    return this.store.findByReference(id, { includeArchived: true })?.key || null;
  }
  findByQuery(query) {
    const record = this.store.findByQuery(query);
    return record ? { initiative: record.initiative, key: record.key } : null;
  }
  list(includeArchived = false) {
    return this.store.list({ includeArchived }).map((record) => record.initiative);
  }
  findRelated(queryTags) {
    const files = fs8.readdirSync(this.dir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
    const initiatives = [];
    for (const f of files) {
      try {
        const init = this.read(f);
        if (init) initiatives.push(init);
      } catch {
      }
    }
    return initiatives.filter((i) => i.tags.some((t) => queryTags.includes(t)));
  }
  findBlocked() {
    const all = this.listAll();
    return all.filter((i) => {
      if (!i.dependsOn || i.dependsOn.length === 0) return false;
      return i.dependsOn.some((depId) => {
        const dep = all.find((d) => d.id === depId);
        return dep && !isCompleted(dep.status);
      });
    });
  }
  findOverdue() {
    const today2 = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    return this.listAll().filter((i) => {
      if (!i.dueDate || isCompleted(i.status)) return false;
      return i.dueDate < today2;
    });
  }
  listByPriority() {
    const priorityOrder = {
      "critical": 0,
      "high": 1,
      "medium": 2,
      "low": 3
    };
    return this.listAll().sort((a, b) => {
      const priA = priorityOrder[a.priority || "medium"] ?? 2;
      const priB = priorityOrder[b.priority || "medium"] ?? 2;
      if (priA !== priB) return priA - priB;
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });
  }
  validate() {
    const errors = [];
    const warnings = [];
    const ids = /* @__PURE__ */ new Map();
    const files = this.validationFiles();
    const wikiRoot = path9.join(path9.dirname(this.dir), "wiki");
    const metadataOnly = this.contract.initiativeMode === "directory" && this.contract.initiativeRecordMode === "metadata-only";
    for (const fileName of files) {
      let initiative;
      let front = {};
      try {
        const content = fs8.readFileSync(path9.join(this.dir, fileName), "utf8");
        const match = content.match(/---\n([\s\S]*?)\n---/);
        if (match) {
          for (const line of match[1].split("\n")) {
            const [key, ...valueParts] = line.split(":");
            if (key && valueParts.length > 0) {
              const value = valueParts.join(":").trim();
              try {
                front[key.trim()] = JSON.parse(value);
              } catch {
                front[key.trim()] = value;
              }
            }
          }
        }
        const parsed = this.read(fileName.endsWith("_status.md") ? fileName.split(path9.sep)[0] : fileName);
        if (!parsed) continue;
        initiative = parsed;
      } catch (err) {
        errors.push(`${fileName} invalid initiative format: ${err.message || String(err)}`);
        continue;
      }
      if (!metadataOnly && !front.id) errors.push(`${fileName} missing id`);
      if (!metadataOnly && !front.title) errors.push(`${fileName} missing title`);
      if (!front.status) errors.push(`${fileName} missing status`);
      if (!front.created && this.contract.initiativeMode !== "directory") errors.push(`${fileName} missing created`);
      if (initiative.id) {
        const firstFile = ids.get(initiative.id);
        if (firstFile) {
          errors.push(`Duplicate initiative id "${initiative.id}" in ${firstFile} and ${fileName}`);
        } else {
          ids.set(initiative.id, fileName);
        }
      }
      for (const ref of initiative.relatedWiki || []) {
        if (typeof ref !== "string") {
          warnings.push(`${fileName} has non-string wiki reference: ${String(ref)}`);
          continue;
        }
        const parts = ref.split("/").filter(Boolean);
        if (parts.length === 1) {
          const [id2] = parts;
          if (!isSafePathSegment(id2)) warnings.push(`${fileName} has unsafe wiki reference: ${ref}`);
          else if (!fs8.existsSync(path9.join(wikiRoot, `${id2}.md`))) warnings.push(`${fileName} references missing wiki entry: ${ref}`);
          continue;
        }
        const [category, id, ...rest] = parts;
        if (!isSafePathSegment(category) || !isSafePathSegment(id) || rest.length > 0) {
          warnings.push(`${fileName} has unsafe wiki reference: ${ref}`);
        } else if (!fs8.existsSync(path9.join(wikiRoot, category, `${id}.md`))) {
          warnings.push(`${fileName} references missing wiki entry: ${ref}`);
        }
      }
    }
    const indexPath = path9.join(this.dir, "INDEX.md");
    if (this.contract.initiativeMode === "directory" && this.contract.wikiIndexOwner === "external") {
      if (!fs8.existsSync(indexPath)) {
        errors.push("initiatives/INDEX.md missing external compiled index");
      } else {
        const listed = this.markdownDestinations(fs8.readFileSync(indexPath, "utf8"));
        for (const fileName of files) {
          const id = fileName.split(path9.sep)[0];
          if (!listed.has(id) && !listed.has(`${id}/_status`)) {
            errors.push(`initiatives/INDEX.md missing link to directory initiative: ${id}`);
          }
        }
      }
    } else if (fs8.existsSync(indexPath)) {
      const indexContent = fs8.readFileSync(indexPath, "utf8");
      const listed = this.listedIndexFiles(indexContent);
      const actual = new Set(files);
      for (const listedFile of listed) {
        if (!actual.has(listedFile)) warnings.push(`INDEX.md lists missing initiative file: ${listedFile}`);
      }
      for (const actualFile of actual) {
        if (!listed.has(actualFile)) warnings.push(`INDEX.md missing initiative file: ${actualFile}`);
      }
    }
    if (this.contract.initiativeMode === "directory") {
      const overviewPath = path9.join(wikiRoot, "overview.md");
      const overviewRefs = fs8.existsSync(overviewPath) ? this.markdownDestinations(fs8.readFileSync(overviewPath, "utf8")) : null;
      for (const fileName of files) {
        const source = this.read(fileName.split(path9.sep)[0]);
        if (!source || source.status !== "active") continue;
        const id = source.id;
        const plural = path9.join(wikiRoot, "initiatives", `${id}.md`);
        const singular = path9.join(wikiRoot, "initiative", `${id}.md`);
        const compiledPath = fs8.existsSync(plural) ? plural : fs8.existsSync(singular) ? singular : null;
        if (!compiledPath) {
          errors.push(`${fileName} active initiative missing compiled wiki page: wiki/initiatives/${id}.md`);
          continue;
        }
        const compiledFront = parseFrontmatter(fs8.readFileSync(compiledPath, "utf8"));
        if (compiledFront.status === void 0 || compiledFront.status === "") {
          errors.push(`${path9.relative(path9.dirname(this.dir), compiledPath)} missing status`);
        } else if (!this.statusesEquivalent(source.status, String(compiledFront.status))) {
          errors.push(`${path9.relative(path9.dirname(this.dir), compiledPath)} status ${compiledFront.status} does not match source status ${source.status}`);
        }
        if (this.contract.wikiIndexOwner === "external") {
          if (!overviewRefs) {
            errors.push("wiki/overview.md missing external compiled overview");
          } else {
            const category = path9.basename(path9.dirname(compiledPath));
            const categoryAlias = category.endsWith("s") ? category.slice(0, -1) : `${category}s`;
            if (!overviewRefs.has(`${category}/${id}`) && !overviewRefs.has(`${categoryAlias}/${id}`)) {
              errors.push(`wiki/overview.md missing link to active initiative: ${id}`);
            }
          }
        }
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }
  statusesEquivalent(source, compiled) {
    return normalizeInitiativeStatus(source) === normalizeInitiativeStatus(compiled);
  }
  checkConsistency() {
    const missing = [];
    const orphans = [];
    let stale = false;
    if (this.contract.initiativeMode === "directory") {
      return { consistent: true, missing, orphans, stale };
    }
    const indexPath = path9.join(this.dir, "INDEX.md");
    if (!fs8.existsSync(indexPath)) {
      return { consistent: false, missing: ["INDEX.md missing"], orphans: [], stale: true };
    }
    const indexContent = fs8.readFileSync(indexPath, "utf8");
    const listed = this.listedIndexFiles(indexContent);
    const actualFiles = this.initiativeFiles();
    const actual = new Set(actualFiles);
    for (const listedFile of listed) {
      if (!actual.has(listedFile)) {
        missing.push(listedFile);
      }
    }
    for (const actualFile of actualFiles) {
      if (!listed.has(actualFile)) {
        orphans.push(actualFile);
      }
    }
    const indexMtime = fs8.statSync(indexPath).mtimeMs;
    for (const fileName of actualFiles) {
      const filePath = path9.join(this.dir, fileName);
      const fileMtime = fs8.statSync(filePath).mtimeMs;
      if (fileMtime > indexMtime) {
        stale = true;
        break;
      }
    }
    return {
      consistent: missing.length === 0 && orphans.length === 0 && !stale,
      missing,
      orphans,
      stale
    };
  }
  listAll() {
    return this.list();
  }
  updateArchiveIndex() {
    const archiveDir = path9.join(this.dir, "archive");
    fs8.mkdirSync(archiveDir, { recursive: true });
    const files = fs8.readdirSync(archiveDir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
    const entries = [];
    for (const f of files) {
      try {
        const content = fs8.readFileSync(path9.join(archiveDir, f), "utf8");
        const init = this.parseInitiative(content, f);
        entries.push({ initiative: init, fileName: f });
      } catch {
      }
    }
    const lines = entries.map(({ initiative: i, fileName }) => `- **${i.title}** (${i.status}) \u2014 ${fileName} \u2014 ${i.created} \u2014 [${i.tags.join(", ")}]`);
    fs8.writeFileSync(path9.join(archiveDir, "INDEX.md"), `# Archived Initiatives

${lines.join("\n") || "No archived initiatives yet."}`, "utf8");
  }
  writeIndexMeta() {
    const metaPath = path9.join(path9.dirname(this.dir), ".index-meta.json");
    const meta = { lastSync: (/* @__PURE__ */ new Date()).toISOString() };
    fs8.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  }
  updateIndex() {
    if (this.contract.initiativeMode === "directory") {
      return;
    }
    const files = this.initiativeFiles();
    const entries = [];
    for (const f of files) {
      try {
        const init = this.read(f);
        if (init) entries.push({ initiative: init, fileName: f });
      } catch {
      }
    }
    const lines = entries.map(({ initiative: i, fileName }) => `- **${i.title}** (${i.status}) \u2014 ${fileName} \u2014 ${i.created} \u2014 [${i.tags.join(", ")}]`);
    const index = `# Initiatives

${lines.join("\n") || "No initiatives yet."}`;
    fs8.writeFileSync(path9.join(this.dir, "INDEX.md"), index, "utf8");
    this.writeIndexMeta();
  }
};

// src/core/managers/mdocs.ts
var fs9 = __toESM(require("fs"));
var path10 = __toESM(require("path"));
var MdocsManager = class {
  baseDir;
  contract;
  constructor(baseDir, compatibility = {}) {
    if (!baseDir || typeof baseDir !== "string") {
      throw new Error("baseDir must be a non-empty string");
    }
    this.baseDir = path10.resolve(baseDir);
    this.contract = detectMdocsContract(this.baseDir, compatibility);
  }
  init() {
    const initiativesDir = path10.join(this.baseDir, "initiatives");
    const wikiDir = path10.join(this.baseDir, "wiki");
    fs9.mkdirSync(initiativesDir, { recursive: true });
    fs9.mkdirSync(wikiDir, { recursive: true });
    this.writeIndex(path10.join(initiativesDir, "INDEX.md"), "# Initiatives\n\nNo initiatives yet.");
    if (this.contract.wikiIndexMode === "generated-uppercase") {
      this.writeIndex(path10.join(wikiDir, "INDEX.md"), "# Wiki\n\nNo entries yet.");
    } else if (this.contract.wikiIndexMode === "canonical-lowercase") {
      this.writeIndex(path10.join(wikiDir, "index.md"), "# Wiki\n\nNo entries yet.");
    }
  }
  writeIndex(filePath, content) {
    if (!fs9.existsSync(filePath)) {
      fs9.writeFileSync(filePath, content, "utf8");
    }
  }
  exists() {
    const initiativesPath = path10.join(this.baseDir, "initiatives");
    const wikiPath = path10.join(this.baseDir, "wiki");
    const initiativesIndex = path10.join(initiativesPath, "INDEX.md");
    const wikiIndex = this.contract.wikiIndexMode === "canonical-lowercase" ? path10.join(wikiPath, "index.md") : path10.join(wikiPath, "INDEX.md");
    const hasDirectoryInitiative = this.hasDirectoryInitiative(initiativesPath);
    return fs9.existsSync(initiativesPath) && fs9.existsSync(wikiPath) && fs9.statSync(initiativesPath).isDirectory() && fs9.statSync(wikiPath).isDirectory() && (fs9.existsSync(initiativesIndex) || this.contract.initiativeMode === "directory" || hasDirectoryInitiative) && (this.contract.wikiIndexMode === "none" || fs9.existsSync(wikiIndex));
  }
  hasDirectoryInitiative(initiativesPath) {
    if (!fs9.existsSync(initiativesPath) || !fs9.statSync(initiativesPath).isDirectory()) return false;
    return fs9.readdirSync(initiativesPath, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory() || entry.name === "archive" || entry.name === "_archive") return false;
      return fs9.existsSync(path10.join(initiativesPath, entry.name, "_status.md"));
    });
  }
  getMetaPath() {
    return path10.join(this.baseDir, ".index-meta.json");
  }
  writeIndexMeta() {
    const metaPath = this.getMetaPath();
    const meta = { lastSync: (/* @__PURE__ */ new Date()).toISOString() };
    fs9.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  }
  readIndexMeta() {
    const metaPath = this.getMetaPath();
    if (!fs9.existsSync(metaPath)) {
      return { lastSync: null };
    }
    try {
      const content = fs9.readFileSync(metaPath, "utf8");
      const meta = JSON.parse(content);
      return { lastSync: meta.lastSync || null };
    } catch {
      return { lastSync: null };
    }
  }
};

// src/core/managers/wiki.ts
var fs10 = __toESM(require("fs"));
var path11 = __toESM(require("path"));
var REMOVE_KEY = /* @__PURE__ */ Symbol("remove-frontmatter-key");
var RAW_KEY_ALIASES = {
  sources: "source_initiatives"
};
function categoryMatchesDir(category, dir) {
  if (category === dir) return true;
  const singular = (value) => value.endsWith("s") ? value.slice(0, -1) : value;
  return singular(category) === singular(dir);
}
var WikiManager = class {
  dir;
  standaloneCategories;
  contract;
  constructor(baseDir, options = {}) {
    this.dir = path11.join(baseDir, "wiki");
    this.standaloneCategories = new Set((options.standaloneCategories || []).map((category) => this.sanitizeName(category)));
    this.contract = detectMdocsContract(baseDir, options.compatibility);
    fs10.mkdirSync(this.dir, { recursive: true });
  }
  toFrontmatter(entry) {
    const front = {
      id: entry.id,
      title: entry.title,
      category: entry.category,
      created: entry.created,
      updated: entry.updated,
      related_initiatives: entry.relatedInitiatives,
      tags: entry.tags
    };
    if (entry.status) front.status = entry.status;
    if (entry.lifecycle) front.lifecycle = entry.lifecycle;
    if (entry.knowledgeType) front.knowledge_type = entry.knowledgeType;
    if (entry.confidence) front.confidence = entry.confidence;
    if (entry.sourceInitiatives && entry.sourceInitiatives.length > 0) front.source_initiatives = entry.sourceInitiatives;
    if (entry.supersedes && entry.supersedes.length > 0) front.supersedes = entry.supersedes;
    if (entry.relatedWiki && entry.relatedWiki.length > 0) front.related_wiki = entry.relatedWiki;
    return `---
${Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}
---

`;
  }
  /**
   * Serialize a WikiEntry's frontmatter losslessly when raw frontmatter was
   * captured at parse time: start from the original lines, replace only
   * managed keys whose value changed, drop managed keys the caller cleared,
   * append managed keys that are new, and keep every unknown key and the
   * original formatting verbatim. Identity keys (id, category) present in the
   * raw block are never rewritten, preserving path-style ids and singular
   * consumer categories. Falls back to a full rebuild when no raw frontmatter
   * was captured (freshly constructed entries).
   */
  serializeFrontmatter(entry) {
    const raw = entry.rawFrontmatter;
    if (!raw) return this.toFrontmatter(entry);
    const managed = this.managedFrontmatterValues(entry, raw);
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const line of raw.lines) {
      const keyMatch = line.match(/^([^:]+):/);
      if (!keyMatch) {
        out.push(line);
        continue;
      }
      const rawKey = keyMatch[1].trim();
      const logical = RAW_KEY_ALIASES[rawKey] ?? rawKey;
      if (!managed.has(logical) || seen.has(logical)) {
        out.push(line);
        continue;
      }
      seen.add(logical);
      const next = managed.get(logical);
      if (next === REMOVE_KEY) continue;
      const prev = raw.values[rawKey];
      if (prev !== void 0 && JSON.stringify(prev) === JSON.stringify(next)) {
        out.push(line);
        continue;
      }
      out.push(`${rawKey}: ${JSON.stringify(next)}`);
    }
    for (const [logical, next] of managed) {
      if (seen.has(logical) || next === REMOVE_KEY) continue;
      out.push(`${logical}: ${JSON.stringify(next)}`);
    }
    const nl = raw.newline;
    return `---${nl}${out.join(nl)}${nl}---${nl}${nl}`;
  }
  /**
   * Managed key → next value for a merged write. Identity keys (id, category)
   * are managed only when absent from the raw block (appended canonically);
   * when present their original lines are preserved verbatim. Optional fields
   * the caller cleared map to REMOVE_KEY so their line is dropped.
   */
  managedFrontmatterValues(entry, raw) {
    const managed = /* @__PURE__ */ new Map();
    if (raw.values.id === void 0) managed.set("id", entry.id);
    if (raw.values.category === void 0) managed.set("category", entry.category);
    managed.set("title", entry.title);
    managed.set("created", entry.created);
    managed.set("updated", entry.updated);
    managed.set("related_initiatives", entry.relatedInitiatives);
    managed.set("tags", entry.tags);
    managed.set("status", entry.status !== void 0 ? entry.status : REMOVE_KEY);
    managed.set("lifecycle", entry.lifecycle !== void 0 ? entry.lifecycle : REMOVE_KEY);
    managed.set("knowledge_type", entry.knowledgeType !== void 0 ? entry.knowledgeType : REMOVE_KEY);
    managed.set("confidence", entry.confidence !== void 0 ? entry.confidence : REMOVE_KEY);
    managed.set("source_initiatives", entry.sourceInitiatives && entry.sourceInitiatives.length > 0 ? entry.sourceInitiatives : REMOVE_KEY);
    managed.set("supersedes", entry.supersedes && entry.supersedes.length > 0 ? entry.supersedes : REMOVE_KEY);
    managed.set("related_wiki", entry.relatedWiki && entry.relatedWiki.length > 0 ? entry.relatedWiki : REMOVE_KEY);
    return managed;
  }
  sanitizeName(name) {
    const base = path11.basename(name);
    if (!base || base === "." || base === "..") {
      throw new Error(`Invalid name: ${name}`);
    }
    return base;
  }
  isRootCategory(category) {
    return category === void 0 || category === "";
  }
  allowsSemanticRootCategory() {
    return this.contract.initiativeMode === "directory" && this.contract.initiativeRecordMode === "metadata-only";
  }
  assertRootWritable(id) {
    if (id.toLowerCase() === "index" && this.contract.wikiIndexMode === "canonical-lowercase") {
      throw new Error("Refusing to overwrite canonical root wiki index: index");
    }
  }
  generateReferencedBySection(initiativeIds) {
    if (initiativeIds.length === 0) return "";
    const lines = initiativeIds.map((id) => `- ${id}`);
    return `

## Referenced By

*Auto-generated by mdocs*

${lines.join("\n")}
`;
  }
  stripReferencedBySection(content) {
    const marker = "\n\n## Referenced By\n";
    const idx = content.indexOf(marker);
    if (idx !== -1) {
      return content.slice(0, idx);
    }
    return content;
  }
  referencedByMarker = "\n\n## Referenced By\n";
  create(entry) {
    const id = this.sanitizeName(entry.id);
    if (this.isRootCategory(entry.category)) {
      this.assertRootWritable(id);
      const filePath2 = path11.join(this.dir, `${id}.md`);
      const content2 = this.serializeFrontmatter({ ...entry, category: "" }) + entry.content + this.generateReferencedBySection(entry.relatedInitiatives);
      fs10.writeFileSync(filePath2, content2, "utf8");
      this.updateIndices();
      return filePath2;
    }
    const category = this.sanitizeName(entry.category);
    const categoryDir = path11.join(this.dir, category);
    fs10.mkdirSync(categoryDir, { recursive: true });
    const filePath = path11.join(categoryDir, `${id}.md`);
    const referencedBy = this.generateReferencedBySection(entry.relatedInitiatives);
    const content = this.serializeFrontmatter(entry) + entry.content + referencedBy;
    fs10.writeFileSync(filePath, content, "utf8");
    this.updateIndices();
    return filePath;
  }
  read(category, id) {
    const cat = this.sanitizeName(category);
    const entryId = this.sanitizeName(id);
    const filePath = path11.join(this.dir, cat, `${entryId}.md`);
    if (!fs10.existsSync(filePath)) return null;
    const content = fs10.readFileSync(filePath, "utf8");
    return this.parseWikiEntry(content, { id: entryId, category: cat });
  }
  readByRef(ref) {
    const parts = ref.split("/").filter(Boolean);
    if (parts.length === 1) return this.readRoot(parts[0]);
    if (parts[0] === "_obsidian") return null;
    if (parts.length === 2) return this.read(parts[0], parts[1].replace(/\.md$/, ""));
    return null;
  }
  refFor(entry) {
    const stem = entry.id ? path11.basename(entry.id) : entry.id;
    if (stem && fs10.existsSync(path11.join(this.dir, `${stem}.md`))) return stem;
    return entry.category ? `${entry.category}/${stem}` : stem;
  }
  readRoot(id) {
    const entryId = this.sanitizeName(id.replace(/\.md$/, ""));
    const filePath = path11.join(this.dir, `${entryId}.md`);
    if (!fs10.existsSync(filePath)) return null;
    const content = fs10.readFileSync(filePath, "utf8");
    return this.parseWikiEntry(content, { id: entryId, category: "" }, this.allowsSemanticRootCategory() && ["overview", "index", "log", "glossary"].includes(entryId));
  }
  parseWikiEntry(content, defaults = {}, physicalCategory = false) {
    const front = parseFrontmatter(content);
    const hasFrontmatter = Object.keys(front).length > 0;
    if (!hasFrontmatter && !defaults.id) throw new Error("Invalid wiki entry format");
    const rawMatch = content.match(/---(\r?\n)([\s\S]*?)\r?\n---/);
    const rawFrontmatter = rawMatch ? {
      lines: rawMatch[2].split(/\r?\n/),
      newline: rawMatch[1] === "\r\n" ? "\r\n" : "\n",
      values: front
    } : void 0;
    let body = hasFrontmatter ? content.replace(/---\n[\s\S]*?\n---/, "").trim() : content.trim();
    body = this.stripReferencedBySection(body);
    const firstHeading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const fallbackTitle = firstHeading || (defaults.id ? defaults.id.replace(/[-_]+/g, " ") : "");
    const rawFrontId = typeof front.id === "string" ? front.id : "";
    const frontIdStem = rawFrontId ? path11.basename(rawFrontId) : "";
    const canonicalId = defaults.id || frontIdStem || rawFrontId || "";
    const canonicalCategory = physicalCategory && defaults.category !== void 0 ? defaults.category : defaults.category || (typeof front.category === "string" ? front.category : "") || "";
    return {
      id: canonicalId,
      title: front.title || fallbackTitle,
      category: canonicalCategory,
      created: front.created || "",
      updated: front.updated || "",
      relatedInitiatives: Array.isArray(front.related_initiatives) ? [...front.related_initiatives] : [],
      tags: Array.isArray(front.tags) ? [...front.tags] : [],
      content: body,
      status: front.status !== void 0 ? String(front.status) : void 0,
      lifecycle: front.lifecycle || void 0,
      knowledgeType: front.knowledge_type || void 0,
      confidence: front.confidence || void 0,
      sourceInitiatives: Array.isArray(front.source_initiatives) ? [...front.source_initiatives] : Array.isArray(front.sources) ? [...front.sources] : void 0,
      supersedes: Array.isArray(front.supersedes) ? [...front.supersedes] : void 0,
      relatedWiki: Array.isArray(front.related_wiki) ? [...front.related_wiki] : void 0,
      rawFrontmatter
    };
  }
  parseRelatedWiki(content) {
    const match = content.match(/---\n([\s\S]*?)\n---/);
    if (!match) return [];
    for (const line of match[1].split("\n")) {
      const [key, ...valueParts] = line.split(":");
      if (key?.trim() !== "related_wiki" || valueParts.length === 0) continue;
      const value = valueParts.join(":").trim();
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
      } catch {
        return [];
      }
    }
    return [];
  }
  referencedWikiRefs() {
    const refs = /* @__PURE__ */ new Set();
    for (const filePath of this.listInitiativeFiles()) {
      try {
        const content = fs10.readFileSync(filePath, "utf8");
        for (const ref of this.parseRelatedWiki(content)) refs.add(ref);
      } catch {
      }
    }
    return refs;
  }
  update(category, id, entry) {
    const entryId = this.sanitizeName(id);
    if (this.isRootCategory(category)) {
      this.assertRootWritable(entryId);
      const filePath2 = path11.join(this.dir, `${entryId}.md`);
      if (!fs10.existsSync(filePath2)) throw new Error(`Wiki entry not found: ${entryId}`);
      entry.updated = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      const cleanContent2 = this.stripReferencedBySection(entry.content);
      const referencedBy2 = this.generateReferencedBySection(entry.relatedInitiatives);
      fs10.writeFileSync(filePath2, this.serializeFrontmatter({ ...entry, category: "" }) + cleanContent2 + referencedBy2, "utf8");
      this.updateIndices();
      return filePath2;
    }
    const cat = this.sanitizeName(category);
    const filePath = path11.join(this.dir, cat, `${entryId}.md`);
    if (!fs10.existsSync(filePath)) {
      throw new Error(`Wiki entry not found: ${cat}/${entryId}`);
    }
    entry.updated = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const cleanContent = this.stripReferencedBySection(entry.content);
    const referencedBy = this.generateReferencedBySection(entry.relatedInitiatives);
    const content = this.serializeFrontmatter(entry) + cleanContent + referencedBy;
    fs10.writeFileSync(filePath, content, "utf8");
    this.updateIndices();
    return filePath;
  }
  addRelatedInitiative(category, id, initiativeId) {
    const entry = this.read(category, id);
    if (!entry) {
      throw new Error(`Wiki entry not found: ${category}/${id}`);
    }
    if (!entry.relatedInitiatives.includes(initiativeId)) {
      entry.relatedInitiatives.push(initiativeId);
      entry.updated = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    }
    return this.update(category, id, entry);
  }
  addRelatedInitiativeByRef(ref, initiativeId) {
    const parts = ref.split("/").filter(Boolean);
    if (parts.length === 1) {
      const id = parts[0].replace(/\.md$/, "");
      const entry = this.readRoot(id);
      if (!entry) throw new Error(`Wiki entry not found: ${ref}`);
      if (!entry.relatedInitiatives.includes(initiativeId)) {
        entry.relatedInitiatives.push(initiativeId);
        entry.updated = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      }
      return this.update("", id, entry);
    }
    if (parts.length === 2) return this.addRelatedInitiative(parts[0], parts[1].replace(/\.md$/, ""), initiativeId);
    throw new Error(`Invalid wikiSlug format: ${ref}. Expected id or category/id`);
  }
  /**
   * Surgical inverse of addRelatedInitiativeByRef: removes one initiative id
   * from a page's related_initiatives. Lossless (routes through the
   * raw-frontmatter merge). Used to roll back failed bidirectional links.
   */
  removeRelatedInitiativeByRef(ref, initiativeId) {
    const parts = ref.split("/").filter(Boolean);
    const apply = (entry, category, entryId) => {
      if (!entry) throw new Error(`Wiki entry not found: ${ref}`);
      if (entry.relatedInitiatives.includes(initiativeId)) {
        entry.relatedInitiatives = entry.relatedInitiatives.filter((item) => item !== initiativeId);
        entry.updated = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      }
      return this.update(category, entryId, entry);
    };
    if (parts.length === 1) {
      const id = parts[0].replace(/\.md$/, "");
      return apply(this.readRoot(id), "", id);
    }
    if (parts.length === 2) {
      const id = parts[1].replace(/\.md$/, "");
      return apply(this.read(parts[0], id), parts[0], id);
    }
    throw new Error(`Invalid wikiSlug format: ${ref}. Expected id or category/id`);
  }
  getReferencedBy(category, id) {
    const entryId = this.sanitizeName(id);
    const cat = this.isRootCategory(category) ? "" : this.sanitizeName(category);
    const wikiRef = cat ? `${cat}/${entryId}` : entryId;
    const accepted = /* @__PURE__ */ new Set([wikiRef, entryId]);
    if (cat) {
      const singular = cat.length > 1 && cat.endsWith("s") ? cat.slice(0, -1) : `${cat}s`;
      accepted.add(`${singular}/${entryId}`);
    }
    const initiativeIds = [];
    for (const filePath of this.listInitiativeFiles()) {
      try {
        const content = fs10.readFileSync(filePath, "utf8");
        const refs = this.parseRelatedWiki(content);
        if (refs.some((ref) => accepted.has(ref))) {
          const front = parseFrontmatter(content);
          if (front.id) {
            initiativeIds.push(front.id);
          }
        }
      } catch {
      }
    }
    return initiativeIds;
  }
  extractWikiRefs(content) {
    const refs = [];
    const bracketMatches = content.matchAll(/\[\[([^\]]+)\/([^\]]+)\]\]/g);
    for (const match of bracketMatches) {
      refs.push(`${match[1]}/${match[2]}`);
    }
    const linkMatches = content.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g);
    for (const match of linkMatches) {
      const href = match[2];
      if (!href.includes("://") && !href.startsWith("http") && href.split("/").length === 2) {
        const parts = href.split("/");
        if (parts[0] && parts[1]) {
          refs.push(href);
        }
      }
    }
    return [...new Set(refs)];
  }
  addWikiCrossRef(fromCategory, fromId, toCategory, toId) {
    const fromEntry = this.read(fromCategory, fromId);
    if (!fromEntry) {
      throw new Error(`Wiki entry not found: ${fromCategory}/${fromId}`);
    }
    const toRef = `${toCategory}/${toId}`;
    if (!fromEntry.relatedWiki) {
      fromEntry.relatedWiki = [];
    }
    if (!fromEntry.relatedWiki.includes(toRef)) {
      fromEntry.relatedWiki.push(toRef);
      fromEntry.updated = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    }
    return this.update(fromCategory, fromId, fromEntry);
  }
  delete(category, id) {
    const entryId = this.sanitizeName(id);
    if (this.isRootCategory(category)) {
      this.assertRootWritable(entryId);
      const filePath2 = path11.join(this.dir, `${entryId}.md`);
      if (fs10.existsSync(filePath2)) {
        fs10.unlinkSync(filePath2);
        this.updateIndices();
      }
      return;
    }
    const cat = this.sanitizeName(category);
    const filePath = path11.join(this.dir, cat, `${entryId}.md`);
    if (fs10.existsSync(filePath)) {
      fs10.unlinkSync(filePath);
      this.updateIndices();
    }
  }
  list(category) {
    if (category && this.sanitizeName(category) === "_obsidian") return [];
    const categories = category ? [this.sanitizeName(category)] : this.categoryDirs();
    const entries = [];
    if (!category) {
      for (const filePath of this.rootWikiFiles()) {
        try {
          const entry = this.readRoot(path11.basename(filePath, ".md"));
          if (entry) entries.push(entry);
        } catch {
        }
      }
    }
    for (const cat of categories) {
      const catDir = path11.join(this.dir, cat);
      if (!fs10.existsSync(catDir)) continue;
      const files = fs10.readdirSync(catDir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
      for (const fileName of files) {
        try {
          const entry = this.read(cat, fileName.replace(/\.md$/, ""));
          if (entry) entries.push(entry);
        } catch {
        }
      }
    }
    return entries.sort((a, b) => `${a.category}/${a.id}`.localeCompare(`${b.category}/${b.id}`));
  }
  syncIndices() {
    if (this.contract.wikiIndexOwner !== "harness") {
      return [];
    }
    if (this.contract.wikiIndexMode === "canonical-lowercase") {
      this.writeLowercaseCanonicalIndex();
      return [path11.join(this.dir, "index.md")];
    }
    this.updateIndices();
    const paths = [path11.join(this.dir, "INDEX.md")];
    const categories = this.categoryDirs();
    for (const category of categories) {
      paths.push(path11.join(this.dir, category, "INDEX.md"));
    }
    return paths;
  }
  findRelated(queryTags) {
    return this.list().filter((entry) => entry.tags.some((t) => queryTags.includes(t)));
  }
  stub(category, id, title, template) {
    const entryId = this.sanitizeName(id);
    if (this.isRootCategory(category)) {
      this.assertRootWritable(entryId);
      const filePath2 = path11.join(this.dir, `${entryId}.md`);
      if (fs10.existsSync(filePath2)) return { success: false, existing: true, filePath: filePath2 };
      const date2 = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      const stubContent2 = template || this.entityOrGenericStubTemplate(title || entryId, "", entryId, date2);
      fs10.writeFileSync(filePath2, stubContent2, "utf8");
      this.updateIndices();
      return { success: true, filePath: filePath2 };
    }
    const cat = this.sanitizeName(category);
    const categoryDir = path11.join(this.dir, cat);
    fs10.mkdirSync(categoryDir, { recursive: true });
    const filePath = path11.join(categoryDir, `${entryId}.md`);
    if (fs10.existsSync(filePath)) {
      return { success: false, existing: true, filePath };
    }
    const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const stubTitle = title || entryId;
    const stubContent = template || this.entityOrGenericStubTemplate(stubTitle, cat, entryId, date);
    fs10.writeFileSync(filePath, stubContent, "utf8");
    this.updateIndices();
    return { success: true, filePath };
  }
  defaultStubTemplate(title, category, id, date) {
    return `---
id: "${id}"
title: "${title}"
category: "${category}"
created: "${date}"
updated: "${date}"
related_initiatives: []
tags: []
---

## Overview

<!-- Add overview here -->

## Details

<!-- Add details here -->

## References

- Linked from initiative: <!-- initiative ids will be auto-populated -->
`;
  }
  entityOrGenericStubTemplate(title, category, id, date) {
    if (category === "repos") return this.defaultRepoTemplate(title, id, date);
    if (category === "systems") return this.defaultSystemTemplate(title, id, date);
    return this.defaultStubTemplate(title, category, id, date);
  }
  defaultRepoTemplate(title, id, date) {
    return `---
id: "${id}"
title: "${title}"
category: "repos"
created: "${date}"
updated: "${date}"
related_initiatives: []
tags: []
---

# ${title}

## Summary

<!-- One-paragraph summary of the repository -->

## Responsibilities

<!-- What this repo owns and is accountable for -->

## Dependencies

<!-- Upstream/downstream repositories and systems -->

## Owners / Links

<!-- Owners, URL, and key links -->
`;
  }
  defaultSystemTemplate(title, id, date) {
    return `---
id: "${id}"
title: "${title}"
category: "systems"
created: "${date}"
updated: "${date}"
related_initiatives: []
tags: []
---

# ${title}

## Summary

<!-- One-paragraph summary of the system -->

## Boundaries

<!-- System scope: what is in and out of this system -->

## Dependencies

<!-- Upstream/downstream systems and repos -->

## Owners / Links

<!-- Owners, URL, and key links -->
`;
  }
  validate() {
    const errors = [];
    const warnings = [];
    const referencedWiki = this.referencedWikiRefs();
    const categories = this.categoryDirs();
    const initiativesDir = path11.join(path11.dirname(this.dir), "initiatives");
    if (fs10.existsSync(initiativesDir)) {
      for (const filePath of this.listInitiativeFiles()) {
        try {
          const content = fs10.readFileSync(filePath, "utf8");
          for (const ref of this.parseRelatedWiki(content)) {
            if (!this.readByRef(ref)) {
              errors.push(`Initiative ${path11.relative(initiativesDir, filePath)} references missing wiki entry: ${ref}`);
            }
          }
        } catch {
        }
      }
    }
    for (const category of categories) {
      const catDir = path11.join(this.dir, category);
      const files = fs10.readdirSync(catDir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
      for (const fileName of files) {
        const relativeName = `${category}/${fileName}`;
        try {
          const entry = this.parseWikiEntry(fs10.readFileSync(path11.join(catDir, fileName), "utf8"));
          if (!entry.id) errors.push(`${relativeName} missing id`);
          if (!entry.title) errors.push(`${relativeName} missing title`);
          if (!entry.category) errors.push(`${relativeName} missing category`);
          const raw = entry.rawFrontmatter?.values || {};
          const stem = fileName.replace(/\.md$/, "");
          if (typeof raw.id === "string" && raw.id !== stem && raw.id !== `${category}/${stem}`) {
            errors.push(`${relativeName} raw id ${raw.id} does not match file identity ${category}/${stem}`);
          }
          if (typeof raw.category === "string" && !categoryMatchesDir(raw.category, category)) {
            errors.push(`${relativeName} raw category ${raw.category} does not match directory ${category}`);
          }
          const hasSourceInitiatives = Array.isArray(entry.sourceInitiatives) && entry.sourceInitiatives.length > 0;
          const isStable = entry.lifecycle === "stable";
          const isStandaloneCategory = this.standaloneCategories.has(entry.category);
          const isReferencedByInitiative = entry.id && entry.category && referencedWiki.has(`${entry.category}/${entry.id}`);
          if (entry.id && entry.category && !isStable && !isStandaloneCategory && !hasSourceInitiatives && !isReferencedByInitiative) {
            warnings.push(`${relativeName} is not referenced by any initiative`);
          }
        } catch (err) {
          errors.push(`${relativeName} invalid wiki entry format: ${err.message || String(err)}`);
        }
      }
    }
    for (const filePath of this.rootWikiFiles()) {
      const relativeName = path11.basename(filePath);
      try {
        const entry = this.readRoot(path11.basename(filePath, ".md"));
        if (!entry) continue;
        if (!entry.id) errors.push(`${relativeName} missing id`);
        if (!entry.title) errors.push(`${relativeName} missing title`);
        const raw = entry.rawFrontmatter?.values || {};
        const stem = path11.basename(filePath, ".md");
        if (typeof raw.id === "string" && raw.id !== stem) errors.push(`${relativeName} raw id ${raw.id} does not match file identity ${stem}`);
        const compatibleSemanticCategory = this.allowsSemanticRootCategory() && ["overview", "index", "log", "glossary"].includes(stem) && raw.category === stem;
        if (typeof raw.category === "string" && raw.category !== "" && !compatibleSemanticCategory) {
          errors.push(`${relativeName} raw category ${raw.category} does not match root wiki`);
        }
      } catch (err) {
        errors.push(`${relativeName} invalid wiki entry format: ${err.message || String(err)}`);
      }
    }
    if (this.contract.initiativeMode === "directory" && this.contract.wikiIndexOwner === "external") {
      const indexPath = path11.join(this.dir, "index.md");
      if (!fs10.existsSync(indexPath)) {
        errors.push("wiki/index.md missing external compiled index");
      } else {
        const refs = this.markdownDestinations(fs10.readFileSync(indexPath, "utf8"));
        for (const entry of this.list()) {
          if (entry.id === "index" && entry.category === "") continue;
          const ref = entry.category ? `${entry.category}/${entry.id}` : entry.id;
          if (!refs.has(ref) && (entry.category || !refs.has(entry.id))) errors.push(`wiki/index.md missing link to wiki page: ${ref}`);
        }
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }
  markdownDestinations(content) {
    const refs = /* @__PURE__ */ new Set();
    const addRef = (value) => {
      let ref = value.split(/[?#]/)[0].replace(/\\/g, "/");
      while (ref.startsWith("./")) ref = ref.slice(2);
      if (ref.endsWith(".md")) ref = ref.slice(0, -3);
      if (ref) refs.add(ref.replace(/\/$/, ""));
    };
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
      addRef(match[1]);
    }
    for (const match of content.matchAll(/`((?:\.\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+\/?)`/g)) {
      addRef(match[1]);
    }
    return refs;
  }
  rootWikiFiles() {
    if (!fs10.existsSync(this.dir)) return [];
    return fs10.readdirSync(this.dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md").map((entry) => path11.join(this.dir, entry.name));
  }
  categoryDirs() {
    if (!fs10.existsSync(this.dir)) return [];
    return fs10.readdirSync(this.dir).filter((f) => f !== "_obsidian" && fs10.statSync(path11.join(this.dir, f)).isDirectory());
  }
  listInitiativeFiles() {
    const initiativesDir = path11.join(path11.dirname(this.dir), "initiatives");
    if (!fs10.existsSync(initiativesDir)) return [];
    const files = [];
    for (const entry of fs10.readdirSync(initiativesDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md") files.push(path11.join(initiativesDir, entry.name));
      if (entry.isDirectory() && entry.name !== "archive" && entry.name !== "_archive") {
        const statusPath = path11.join(initiativesDir, entry.name, "_status.md");
        if (fs10.existsSync(statusPath)) files.push(statusPath);
      }
    }
    return files;
  }
  checkConsistency() {
    const missing = [];
    const orphans = [];
    let stale = false;
    if (this.contract.wikiIndexOwner !== "harness") {
      if (this.contract.wikiIndexMode === "canonical-lowercase" && !fs10.existsSync(path11.join(this.dir, "index.md"))) {
        missing.push("wiki/index.md");
      }
      return {
        consistent: missing.length === 0,
        missing,
        orphans,
        stale
      };
    }
    const categories = this.categoryDirs();
    const rootIndexPath = path11.join(this.dir, "INDEX.md");
    if (!fs10.existsSync(rootIndexPath)) {
      missing.push("wiki/INDEX.md");
    } else {
      const rootIndexMtime = fs10.statSync(rootIndexPath).mtimeMs;
      const rootContent = fs10.readFileSync(rootIndexPath, "utf8");
      const listedCategories = new Set(Array.from(rootContent.matchAll(/\[([^\]]+)\]\([^)]*INDEX\.md\)/g)).map((m) => m[1]));
      for (const category of categories) {
        if (!listedCategories.has(category)) {
          orphans.push(`wiki/${category}/ (missing from root INDEX)`);
        }
      }
    }
    for (const category of categories) {
      const catDir = path11.join(this.dir, category);
      const catIndexPath = path11.join(catDir, "INDEX.md");
      const catFiles = fs10.readdirSync(catDir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
      if (!fs10.existsSync(catIndexPath)) {
        missing.push(`wiki/${category}/INDEX.md`);
        continue;
      }
      const catIndexMtime = fs10.statSync(catIndexPath).mtimeMs;
      const catContent = fs10.readFileSync(catIndexPath, "utf8");
      const knownIds = /* @__PURE__ */ new Set();
      for (const m of catContent.matchAll(/^- (.+)$/gm)) {
        const line = m[1].trim();
        const linkMatch = line.match(/^\[([^\]]+)\]\(([^)]+)\.md\)$/);
        if (linkMatch) {
          knownIds.add(linkMatch[2].trim().toLowerCase());
        } else {
          knownIds.add(line.toLowerCase().replace(/\s+/g, "-"));
        }
      }
      const fileAliases = /* @__PURE__ */ new Map();
      for (const fileName of catFiles) {
        const filePath = path11.join(catDir, fileName);
        const filenameId = fileName.replace(".md", "");
        const aliases = /* @__PURE__ */ new Set([filenameId.toLowerCase()]);
        try {
          const content = fs10.readFileSync(filePath, "utf8");
          const fmMatch = content.match(/---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const idMatch = fmMatch[1].match(/^id:\s*"?([^"\n]+)"?/m);
            if (idMatch) aliases.add(idMatch[1].trim().toLowerCase());
            const titleMatch = fmMatch[1].match(/^title:\s*"?([^"\n]+)"?/m);
            if (titleMatch) {
              aliases.add(titleMatch[1].trim().toLowerCase().replace(/\s+/g, "-"));
            }
          }
        } catch {
        }
        fileAliases.set(filenameId, aliases);
      }
      for (const known of knownIds) {
        const found = Array.from(fileAliases.values()).some((aliases) => aliases.has(known));
        if (!found) {
          missing.push(`wiki/${category}/${known}.md`);
        }
      }
      for (const [filenameId, aliases] of fileAliases) {
        const found = Array.from(aliases).some((a) => knownIds.has(a));
        if (!found) {
          orphans.push(`wiki/${category}/${filenameId}.md`);
        }
      }
      for (const fileName of catFiles) {
        const filePath = path11.join(catDir, fileName);
        const fileMtime = fs10.statSync(filePath).mtimeMs;
        if (fileMtime > catIndexMtime) {
          stale = true;
        }
      }
    }
    return {
      consistent: missing.length === 0 && orphans.length === 0 && !stale,
      missing,
      orphans,
      stale
    };
  }
  writeIndexMeta() {
    const metaPath = path11.join(path11.dirname(this.dir), ".index-meta.json");
    const meta = { lastSync: (/* @__PURE__ */ new Date()).toISOString() };
    fs10.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  }
  updateIndices() {
    if (this.contract.wikiIndexOwner !== "harness") {
      return;
    }
    if (this.contract.wikiIndexMode === "canonical-lowercase") {
      this.writeLowercaseCanonicalIndex();
      return;
    }
    const categories = this.categoryDirs();
    for (const category of categories) {
      const catDir = path11.join(this.dir, category);
      const files = fs10.readdirSync(catDir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
      const lines = files.map((f) => {
        const content = fs10.readFileSync(path11.join(catDir, f), "utf8");
        const frontmatterMatch = content.match(/---\n([\s\S]*?)\n---/);
        let title = null;
        let id = null;
        if (frontmatterMatch) {
          const idMatch = frontmatterMatch[1].match(/^id:\s*"?([^"\n]+)"?/m);
          if (idMatch) id = idMatch[1].trim();
          const titleMatch = frontmatterMatch[1].match(/^title:\s*"?([^"\n]+)"?/m);
          if (titleMatch) title = titleMatch[1].trim();
        }
        const safeTitle = title || f.replace(".md", "");
        const safeId = id || f.replace(".md", "");
        return `- [${safeTitle}](${safeId}.md)`;
      });
      const index = `# ${category}

${lines.join("\n") || "No entries yet."}`;
      fs10.writeFileSync(path11.join(catDir, "INDEX.md"), index, "utf8");
    }
    const catLines = categories.map((c) => `- [${c}](${c}/INDEX.md)`);
    const rootIndex = `# Wiki

## Categories

${catLines.join("\n")}`;
    fs10.writeFileSync(path11.join(this.dir, "INDEX.md"), rootIndex, "utf8");
    this.writeIndexMeta();
  }
  /**
   * Build the lowercase canonical `wiki/index.md` content. Format matches the
   * grouped/status-tagged style already in use: `# Wiki` header, a stable
   * descriptive sentence, then one `- [Title](relative-path.md)` line per wiki
   * entry (root and category) sorted by relative path so output is byte-stable
   * across runs given the same on-disk set.
   */
  generateLowercaseCanonicalIndex() {
    const entries = [];
    for (const filePath of this.rootWikiFiles()) {
      const fileName = path11.basename(filePath);
      if (fileName === "index.md" || fileName === "INDEX.md") continue;
      const id = fileName.replace(/\.md$/, "");
      let title = id;
      try {
        const parsed = this.readRoot(id);
        if (parsed?.title) title = parsed.title;
      } catch {
      }
      entries.push({ title, relPath: fileName });
    }
    for (const category of this.categoryDirs()) {
      const catDir = path11.join(this.dir, category);
      const files = fs10.readdirSync(catDir).filter((f) => f.endsWith(".md") && f !== "INDEX.md" && f !== "index.md");
      for (const fileName of files) {
        const id = fileName.replace(/\.md$/, "");
        let title = id;
        try {
          const parsed = this.read(category, id);
          if (parsed?.title) title = parsed.title;
        } catch {
        }
        entries.push({ title, relPath: `${category}/${fileName}` });
      }
    }
    entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const lines = entries.map((e) => `- [${e.title}](${e.relPath})`);
    return `# Wiki

Auto-maintained canonical index. Regenerated by mdocs index.sync.

${lines.join("\n") || "No entries yet."}
`;
  }
  writeLowercaseCanonicalIndex() {
    const content = this.generateLowercaseCanonicalIndex();
    fs10.writeFileSync(path11.join(this.dir, "index.md"), content, "utf8");
    this.writeIndexMeta();
  }
  /**
   * Serialize the minimal root-file frontmatter shape used by the harness-owned
   * compiled views (overview.md, log.md). Mirrors the JSON-serialized style of
   * `toFrontmatter` (key: <JSON>) so the files pass `validate()` root-file
   * checks and parse cleanly via `readRoot`.
   */
  serializeCompiledViewFrontmatter(id, title, date) {
    const front = {
      id,
      title,
      category: "",
      created: date,
      updated: date,
      related_initiatives: [],
      tags: []
    };
    return `---
${Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}
---

`;
  }
  /**
   * Idempotently set one named H2 section of wiki/overview.md. Creates the file
   * (frontmatter + '# Overview') if absent. If the section exists, replaces its
   * body in place preserving all other sections byte-for-byte; if absent, appends
   * a new section at the end. Bumps the frontmatter `updated` date.
   * No-op (returns null) outside directory-v2 (canonical-lowercase) mode.
   * Never writes wiki/index.md directly.
   */
  updateOverviewSection(section, body) {
    if (this.contract.wikiIndexMode !== "canonical-lowercase") return null;
    const filePath = path11.join(this.dir, "overview.md");
    const today2 = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const trimmedBody = body.trim();
    if (!fs10.existsSync(filePath)) {
      const frontmatter = this.serializeCompiledViewFrontmatter("overview", "Overview", today2);
      const content = `${frontmatter}# Overview

## ${section}

${trimmedBody}
`;
      fs10.writeFileSync(filePath, content, "utf8");
      this.updateIndices();
      return filePath;
    }
    const raw = fs10.readFileSync(filePath, "utf8");
    const frontmatterMatch = raw.match(/---\n[\s\S]*?\n---/);
    const frontmatterBlock = frontmatterMatch ? frontmatterMatch[0] : "";
    let bodyText = frontmatterMatch ? raw.slice(frontmatterMatch[0].length) : raw;
    bodyText = bodyText.replace(/^\r?\n\r?\n/, "");
    const lines = bodyText.split("\n");
    const preambleLines = [];
    const sections = [];
    let current = null;
    let sawHeading = false;
    for (const line of lines) {
      const headingMatch = /^## (.+)$/.exec(line);
      if (headingMatch) {
        sawHeading = true;
        if (current) sections.push({ name: current.name, body: current.bodyLines.join("\n").replace(/^\r?\n\r?\n/, "").replace(/\n+$/, "") });
        current = { name: headingMatch[1].trim(), bodyLines: [] };
      } else if (current) {
        current.bodyLines.push(line);
      } else {
        preambleLines.push(line);
      }
    }
    if (current) sections.push({ name: current.name, body: current.bodyLines.join("\n").replace(/^\r?\n\r?\n/, "").replace(/\n+$/, "") });
    const preamble = sawHeading ? preambleLines.join("\n").replace(/^\r?\n+/, "").replace(/\n+$/, "") : bodyText.trim();
    let found = false;
    for (const s of sections) {
      if (s.name === section) {
        s.body = trimmedBody;
        found = true;
        break;
      }
    }
    if (!found) sections.push({ name: section, body: trimmedBody });
    const h1Preamble = preamble ? `${preamble}

` : "# Overview\n\n";
    const sectionsText = sections.map((s) => `## ${s.name}

${s.body}`).join("\n\n");
    const assembledBody = `${h1Preamble}${sectionsText}
`;
    let newFrontmatter;
    if (frontmatterBlock) {
      newFrontmatter = frontmatterBlock.replace(/^updated:.*$/m, `updated: ${JSON.stringify(today2)}`);
    } else {
      newFrontmatter = this.serializeCompiledViewFrontmatter("overview", "Overview", today2).replace(/\n\n$/, "");
    }
    fs10.writeFileSync(filePath, `${newFrontmatter}

${assembledBody}`, "utf8");
    this.updateIndices();
    return filePath;
  }
  /**
   * Append one timestamped block to wiki/log.md. Creates the file (frontmatter +
   * '# Log') if absent. The timestamp defaults to new Date().toISOString(); the
   * content is caller-supplied (entry.content, or entry if a string is passed).
   * Existing entries are preserved and never reordered.
   *
   * Consumer-format heading: when BOTH entry.operation and entry.subject are
   * supplied, the block heading is `## [YYYY-MM-DD] {operation} | {subject}`
   * where the date is entry.date (YYYY-MM-DD) or today. The legacy
   * `## {timestamp}` form is preserved byte-for-byte for every other caller.
   *
   * No-op (returns null) outside directory-v2 (canonical-lowercase) mode.
   * Never writes wiki/index.md directly.
   */
  appendLog(entry) {
    if (this.contract.wikiIndexMode !== "canonical-lowercase") return null;
    const filePath = path11.join(this.dir, "log.md");
    const today2 = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const isObj = typeof entry !== "string";
    const content = typeof entry === "string" ? entry : entry.content;
    const trimmedContent = content.trim();
    const operation = isObj ? entry.operation : void 0;
    const subject = isObj ? entry.subject : void 0;
    const useConsumerHeading = !!(operation && subject);
    const dateOrTimestamp = isObj && entry.date || today2;
    const timestamp = isObj && entry.timestamp || (/* @__PURE__ */ new Date()).toISOString();
    const heading = useConsumerHeading ? `[${dateOrTimestamp}] ${operation} | ${subject}` : timestamp;
    if (!fs10.existsSync(filePath)) {
      const frontmatter = this.serializeCompiledViewFrontmatter("log", "Log", today2);
      const fileContent = `${frontmatter}# Log

## ${heading}

${trimmedContent}
`;
      fs10.writeFileSync(filePath, fileContent, "utf8");
      this.updateIndices();
      return filePath;
    }
    const raw = fs10.readFileSync(filePath, "utf8");
    const frontmatterMatch = raw.match(/---\n[\s\S]*?\n---/);
    const frontmatterBlock = frontmatterMatch ? frontmatterMatch[0] : "";
    let bodyText = frontmatterMatch ? raw.slice(frontmatterMatch[0].length) : raw;
    bodyText = bodyText.replace(/^\r?\n\r?\n/, "").replace(/\n+$/, "\n");
    let newFrontmatter;
    if (frontmatterBlock) {
      newFrontmatter = frontmatterBlock.replace(/^updated:.*$/m, `updated: ${JSON.stringify(today2)}`);
    } else {
      newFrontmatter = this.serializeCompiledViewFrontmatter("log", "Log", today2).replace(/\n\n$/, "");
    }
    const appendedBlock = `
## ${heading}

${trimmedContent}
`;
    fs10.writeFileSync(filePath, `${newFrontmatter}

${bodyText}${appendedBlock}`, "utf8");
    this.updateIndices();
    return filePath;
  }
};

// src/core/validation/linter.ts
var fs11 = __toESM(require("fs"));
var path12 = __toESM(require("path"));
function categoryMatchesDir2(category, dir) {
  if (category === dir) return true;
  const catS = category.endsWith("s") ? category.slice(0, -1) : category;
  const dirS = dir.endsWith("s") ? dir.slice(0, -1) : dir;
  return catS === dirS || category === dirS + "s" || dir === catS + "s";
}
function isCategoryWikiRef(ref, wiki) {
  const parts = ref.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === wiki.id && categoryMatchesDir2(parts[0], wiki.category);
}
function slugify3(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}
var MdocsLinter = class {
  baseDir;
  initiativeRecordMode;
  constructor(baseDir, options = {}) {
    this.baseDir = baseDir;
    this.initiativeRecordMode = options.initiativeRecordMode ?? "full";
  }
  lintFile(filePath) {
    const content = fs11.readFileSync(filePath, "utf8");
    const relativePath = path12.relative(this.baseDir, filePath);
    if (filePath.includes("/initiatives/") || filePath.includes("\\initiatives\\")) {
      return this.lintInitiative(content, relativePath);
    }
    if (filePath.includes("/wiki/") || filePath.includes("\\wiki\\")) {
      return this.lintWiki(content, relativePath);
    }
    return {
      file: relativePath,
      type: "initiative",
      score: 0,
      issues: [{ severity: "error", message: "File is not in initiatives/ or wiki/ directory" }],
      passed: false
    };
  }
  lintAll() {
    const results = [];
    const wikiDir = path12.join(this.baseDir, "wiki");
    for (const filePath of this.listInitiativeFiles()) {
      results.push(this.lintFile(filePath));
    }
    if (fs11.existsSync(wikiDir)) {
      for (const filePath of this.rootWikiFiles()) {
        results.push(this.lintFile(filePath));
      }
      const categories = fs11.readdirSync(wikiDir).filter((f) => {
        if (f === "_obsidian") return false;
        const stat = fs11.statSync(path12.join(wikiDir, f));
        return stat.isDirectory();
      });
      for (const category of categories) {
        const catDir = path12.join(wikiDir, category);
        const files = fs11.readdirSync(catDir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
        for (const f of files) {
          results.push(this.lintFile(path12.join(catDir, f)));
        }
      }
    }
    results.push(...this.lintGraph());
    return results;
  }
  lintGraph() {
    const issues = [];
    const initiativesDir = path12.join(this.baseDir, "initiatives");
    const wikiDir = path12.join(this.baseDir, "wiki");
    const initiativeData = [];
    for (const filePath of this.listInitiativeFiles()) {
      try {
        const content = fs11.readFileSync(filePath, "utf8");
        const front = parseFrontmatter(content);
        const relativePath = path12.relative(initiativesDir, filePath);
        const slug = relativePath.endsWith("_status.md") ? relativePath.split(path12.sep)[0] : path12.basename(relativePath, ".md").replace(/--\d{4}-\d{2}-\d{2}$/, "");
        initiativeData.push({
          id: front.id || slug,
          slug,
          aliases: Array.isArray(front.aliases) ? front.aliases : [],
          status: normalizeInitiativeStatus(front.status),
          relatedWiki: Array.isArray(front.related_wiki) ? front.related_wiki : [],
          filePath: relativePath
        });
      } catch {
      }
    }
    const wikiData = [];
    if (fs11.existsSync(wikiDir)) {
      for (const filePath of this.rootWikiFiles()) {
        try {
          const content = fs11.readFileSync(filePath, "utf8");
          const front = parseFrontmatter(content);
          const stem = path12.basename(filePath, ".md");
          wikiData.push({
            id: stem,
            category: "",
            relatedInitiatives: Array.isArray(front.related_initiatives) ? front.related_initiatives : [],
            sourceInitiatives: Array.isArray(front.source_initiatives) ? front.source_initiatives : Array.isArray(front.sources) ? front.sources : [],
            relatedWiki: Array.isArray(front.related_wiki) ? front.related_wiki : [],
            lifecycle: front.lifecycle,
            filePath: path12.basename(filePath)
          });
        } catch {
        }
      }
      const categories = fs11.readdirSync(wikiDir).filter((f) => f !== "_obsidian" && fs11.statSync(path12.join(wikiDir, f)).isDirectory());
      for (const category of categories) {
        const catDir = path12.join(wikiDir, category);
        const files = fs11.readdirSync(catDir).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
        for (const f of files) {
          try {
            const content = fs11.readFileSync(path12.join(catDir, f), "utf8");
            const front = parseFrontmatter(content);
            const id = f.replace(/\.md$/, "");
            wikiData.push({
              id,
              category,
              relatedInitiatives: Array.isArray(front.related_initiatives) ? front.related_initiatives : [],
              sourceInitiatives: Array.isArray(front.source_initiatives) ? front.source_initiatives : Array.isArray(front.sources) ? front.sources : [],
              relatedWiki: Array.isArray(front.related_wiki) ? front.related_wiki : [],
              lifecycle: front.lifecycle,
              filePath: `${category}/${f}`
            });
          } catch {
          }
        }
      }
    }
    const canonicalInitiatives = new Set(initiativeData.flatMap((i) => [i.id, i.slug]));
    const initiativeAliases = /* @__PURE__ */ new Map();
    for (const init of initiativeData) {
      for (const alias of init.aliases) {
        initiativeAliases.set(alias, init.id);
        initiativeAliases.set(slugify3(alias), init.id);
      }
    }
    const initiativeIds = /* @__PURE__ */ new Set([...canonicalInitiatives, ...initiativeAliases.keys()]);
    const resolveWikiRef = (ref) => wikiData.find((wiki) => wiki.category ? isCategoryWikiRef(ref, wiki) : ref === wiki.id);
    for (const init of initiativeData) {
      for (const wikiRef of init.relatedWiki) {
        const target = resolveWikiRef(wikiRef);
        if (!target) {
          issues.push({
            severity: "warning",
            message: `Initiative ${init.id} references missing wiki ${wikiRef}`
          });
        }
        if (target && (target.category === "initiative" || target.category === "initiatives") && target.id === init.id) {
          issues.push({ severity: "error", message: `Initiative ${init.id} has self related_wiki reference ${wikiRef}` });
        }
      }
      if (isCompleted(init.status)) {
        const initRefs = /* @__PURE__ */ new Set([init.id, init.slug]);
        const stableWikiLinks = init.relatedWiki.filter((ref) => {
          const wikiEntry = resolveWikiRef(ref);
          return wikiEntry && wikiEntry.lifecycle === "stable";
        });
        const stableSourceWiki = wikiData.some((wiki) => wiki.lifecycle === "stable" && wiki.sourceInitiatives.some((source) => initRefs.has(source)));
        if (stableWikiLinks.length === 0 && !stableSourceWiki) {
          issues.push({
            severity: "warning",
            message: `Done initiative ${init.id} has no stable wiki learning`
          });
        }
      }
    }
    for (const wiki of wikiData) {
      for (const initRef of wiki.relatedInitiatives) {
        if (!initiativeIds.has(initRef)) {
          const suggestion = this.suggest(initRef, Array.from(initiativeIds));
          issues.push({
            severity: "warning",
            message: `Wiki ${wiki.category}/${wiki.id} references missing initiative ${initRef}${suggestion ? ` (did you mean ${suggestion}?)` : ""}`
          });
        } else if (!canonicalInitiatives.has(initRef) && initiativeAliases.has(initRef)) {
          issues.push({
            severity: "info",
            message: `Wiki ${wiki.category}/${wiki.id} references initiative alias ${initRef}; canonical id is ${initiativeAliases.get(initRef)}`
          });
        }
        const canonicalId = initiativeAliases.get(initRef);
        const canonicalInit = initiativeData.find((init) => init.id === initRef || init.slug === initRef || init.id === canonicalId);
        if (canonicalInit) {
          const wikiRef2 = wiki.category ? `${wiki.category}/${wiki.id}` : wiki.id;
          const isOwnCompiledPage = (wiki.category === "initiative" || wiki.category === "initiatives") && wiki.id === canonicalInit.id;
          const hasReciprocal = wiki.category ? canonicalInit.relatedWiki.some((ref) => isCategoryWikiRef(ref, wiki)) : canonicalInit.relatedWiki.includes(wiki.id);
          if (!isOwnCompiledPage && !hasReciprocal) {
            issues.push({ severity: "error", message: `Initiative ${canonicalInit.id} missing reciprocal related_wiki link to ${wikiRef2}` });
          }
        }
      }
      const wikiRef = wiki.category ? `${wiki.category}/${wiki.id}` : wiki.id;
      const hasSelfRelatedInitiative = wiki.relatedInitiatives.some(
        (initRef) => (canonicalInitiatives.has(initRef) ? initRef : initiativeAliases.get(initRef) ?? initRef) === wiki.id
      );
      if ((wiki.category === "initiative" || wiki.category === "initiatives") && hasSelfRelatedInitiative) {
        issues.push({ severity: "error", message: `Compiled initiative page ${wikiRef} has self related_initiatives reference` });
      }
      const hasSelfRelatedWiki = wiki.category ? wiki.relatedWiki.some((ref) => isCategoryWikiRef(ref, wiki)) : wiki.relatedWiki.includes(wiki.id);
      if (hasSelfRelatedWiki) {
        issues.push({ severity: "error", message: `Wiki ${wikiRef} has self related_wiki reference` });
      }
      for (const initRef of wiki.sourceInitiatives) {
        if (!initiativeIds.has(initRef)) {
          const suggestion = this.suggest(initRef, Array.from(initiativeIds));
          issues.push({
            severity: "warning",
            message: `Wiki ${wiki.category}/${wiki.id} references missing initiative ${initRef}${suggestion ? ` (did you mean ${suggestion}?)` : ""}`
          });
        } else if (!canonicalInitiatives.has(initRef) && initiativeAliases.has(initRef)) {
          issues.push({
            severity: "info",
            message: `Wiki ${wiki.category}/${wiki.id} references initiative alias ${initRef}; canonical id is ${initiativeAliases.get(initRef)}`
          });
        }
      }
      for (const init of initiativeData) {
        const wikiRef2 = wiki.category ? `${wiki.category}/${wiki.id}` : wiki.id;
        if (init.relatedWiki.some((ref) => resolveWikiRef(ref) === wiki)) {
          if (!wiki.relatedInitiatives.includes(init.id) && !wiki.sourceInitiatives.includes(init.id) && !wiki.sourceInitiatives.includes(init.slug)) {
            issues.push({
              severity: "warning",
              message: `Wiki ${wiki.category}/${wiki.id} missing backlink to initiative ${init.id}`
            });
          }
        }
      }
    }
    if (issues.length === 0) return [];
    return [{
      file: "GRAPH",
      type: "initiative",
      score: 0,
      issues,
      passed: false
    }];
  }
  listInitiativeFiles() {
    const initiativesDir = path12.join(this.baseDir, "initiatives");
    if (!fs11.existsSync(initiativesDir)) return [];
    const files = [];
    for (const entry of fs11.readdirSync(initiativesDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md") {
        files.push(path12.join(initiativesDir, entry.name));
      }
      if (entry.isDirectory() && entry.name !== "archive" && entry.name !== "_archive") {
        const statusPath = path12.join(initiativesDir, entry.name, "_status.md");
        if (fs11.existsSync(statusPath)) files.push(statusPath);
      }
    }
    return files;
  }
  suggest(value, choices) {
    const normalized = value.toLowerCase();
    const prefix = choices.find((choice) => choice.toLowerCase().startsWith(normalized.slice(0, 6)) || normalized.startsWith(choice.toLowerCase().slice(0, 6)));
    if (prefix) return prefix;
    let best = null;
    for (const choice of choices) {
      const distance = levenshtein(normalized, choice.toLowerCase());
      if (!best || distance < best.distance) best = { choice, distance };
    }
    return best && best.distance <= Math.max(3, Math.floor(normalized.length / 3)) ? best.choice : null;
  }
  rootWikiFiles() {
    const wikiDir = path12.join(this.baseDir, "wiki");
    if (!fs11.existsSync(wikiDir)) return [];
    return fs11.readdirSync(wikiDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md").map((entry) => path12.join(wikiDir, entry.name));
  }
  lintInitiative(content, filePath) {
    const issues = [];
    let score = 5;
    const metadataOnly = this.initiativeRecordMode === "metadata-only";
    const frontmatterMatch = content.match(/---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      if (path12.dirname(filePath).split(path12.sep).pop() === "wiki") {
        return { file: filePath, type: "wiki", score: 5, issues: [], passed: true };
      }
      issues.push({ severity: "error", message: "Missing YAML frontmatter" });
      score = 0;
      return { file: filePath, type: "initiative", score, issues, passed: false };
    }
    const frontmatter = frontmatterMatch[1];
    if (!metadataOnly) {
      const requiredFields = ["id", "title", "status", "created", "updated", "tags"];
      for (const field of requiredFields) {
        if (!frontmatter.includes(`${field}:`)) {
          issues.push({ severity: "error", message: `Missing required frontmatter field: ${field}` });
          score -= 1;
        }
      }
    }
    const body = content.replace(/---\n[\s\S]*?\n---/, "").trim();
    if (!metadataOnly) {
      const objectiveMatch = body.match(/## Objective\n([\s\S]*?)(?=\n## |$)/);
      const objective = objectiveMatch ? objectiveMatch[1].trim() : "";
      if (!objective || objective.length < 10) {
        issues.push({ severity: "error", message: "Objective missing or too short (min 10 words)" });
        score -= 1;
      }
      const planMatch = body.match(/## Plan\n([\s\S]*?)(?=\n## |$)/);
      const planSection = planMatch ? planMatch[1].trim() : "";
      const planItems = planSection.split("\n").filter((line) => line.trim().startsWith("- "));
      if (planItems.length === 0) {
        issues.push({ severity: "error", message: "Plan section is empty" });
        score -= 1;
      } else {
        for (const item of planItems) {
          const text = item.replace(/^- \[[ x/]\] /, "").replace(/^- /, "").trim();
          const vaguePrefixes = ["research how", "investigate", "look into", "explore", "learn about", "find out", "check if"];
          if (vaguePrefixes.some((prefix) => text.toLowerCase().startsWith(prefix))) {
            issues.push({ severity: "warning", message: `Vague plan item detected: "${text}"` });
            score -= 0.5;
          }
        }
      }
      const hasContextSection = /## Context/.test(body);
      const hasFilePaths = /\b(src\/[\w/]+\.(ts|js|md)|templates\/|agents\/|skills\/)/.test(body);
      const hasPlanPaths = planItems.some((item) => /\b(src\/[\w/]+|templates\/|agents\/|skills\/)/.test(item));
      if (!hasContextSection && !hasFilePaths && !hasPlanPaths) {
        issues.push({ severity: "error", message: "No file paths or Context section found \u2014 fresh agent won't know where to edit" });
        score -= 2;
      }
      const hasAcceptanceCriteria = /## Acceptance Criteria|done when|acceptance/i.test(body);
      if (!hasAcceptanceCriteria) {
        issues.push({ severity: "warning", message: 'Missing Acceptance Criteria section or "Done when" statements' });
        score -= 0.5;
      }
      const hasProgressLog = /## Progress Log/.test(body);
      if (!hasProgressLog) {
        issues.push({ severity: "warning", message: "Missing Progress Log section" });
        score -= 0.5;
      }
    }
    const front = parseFrontmatter(content);
    const status = normalizeInitiativeStatus(front.status);
    const expectedDuration = readExpectedDurationRaw(front);
    if (status === "active" && expectedDuration !== "suppress") {
      const threshold = expectedDuration === "long" ? 60 : 14;
      const age = this.daysSince(front.created || front.started);
      if (age !== null && age > threshold) {
        issues.push({
          severity: "warning",
          message: `long-running-active: active for ${age} days (expectedDuration ${expectedDuration || "normal"}); mark done, split, or set expectedDuration:'suppress'`
        });
      }
    }
    if (isCompleted(status)) {
      const sinceComplete = this.daysSince(front.completed || front.updated);
      if (sinceComplete !== null && sinceComplete > 30) {
        issues.push({
          severity: "warning",
          message: `stale-complete: completed ${sinceComplete} days ago and not archived; archive or graduate it`
        });
      }
      if (!front.graduated && sinceComplete !== null && sinceComplete > 7) {
        issues.push({
          severity: "warning",
          message: `graduation-due: completed ${sinceComplete} days ago and not graduated; run lifecycle.graduate to record its learning in overview.md/log.md`
        });
      }
    }
    score = Math.max(0, Math.min(5, score));
    const passed = score >= 4;
    return { file: filePath, type: "initiative", score, issues, passed };
  }
  /**
   * Whole-day age between `dateStr` and today. Returns null when the value is
   * missing or unparseable. Lifecycle lint rules use this to compute staleness.
   */
  daysSince(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const today2 = /* @__PURE__ */ new Date();
    return Math.floor((today2.getTime() - d.getTime()) / (1e3 * 60 * 60 * 24));
  }
  lintWiki(content, filePath) {
    const issues = [];
    let score = 5;
    const frontmatterMatch = content.match(/---\n([\s\S]*?)\n---/);
    const isRootWiki = path12.dirname(filePath).split(path12.sep).pop() === "wiki";
    if (!frontmatterMatch) {
      if (isRootWiki) {
        return { file: filePath, type: "wiki", score: 5, issues, passed: true };
      }
      issues.push({ severity: "error", message: "Missing YAML frontmatter" });
      score = 0;
      return { file: filePath, type: "wiki", score, issues, passed: false };
    }
    const frontmatter = frontmatterMatch[1];
    const requiredFields = isRootWiki ? ["id", "title"] : ["id", "title", "category", "updated"];
    for (const field of requiredFields) {
      if (!frontmatter.includes(`${field}:`)) {
        issues.push({ severity: "error", message: `Missing required frontmatter field: ${field}` });
        score -= 1;
      }
    }
    if (!isRootWiki && !frontmatter.includes("created:")) {
      if (!frontmatter.includes("updated:")) {
        issues.push({ severity: "error", message: "Missing required frontmatter field: created (or updated as fallback)" });
        score -= 1;
      }
    }
    if (!frontmatter.includes("tags:")) {
      issues.push({ severity: "info", message: "No tags in frontmatter (optional but recommended)" });
    }
    const body = content.replace(/---\n[\s\S]*?\n---/, "").trim();
    const wordCount = body.split(/\s+/).filter((w) => w.length > 0).length;
    if (wordCount < 50) {
      issues.push({ severity: "warning", message: `Content is short (${wordCount} words, min recommended 50)` });
      score -= 1;
    }
    const categoryMatch = frontmatter.match(/category:\s*"?([^"\n]+)"?/);
    if (categoryMatch) {
      const category = categoryMatch[1].trim();
      const expectedDir = path12.dirname(filePath).split(path12.sep).pop();
      if (!isRootWiki && expectedDir !== void 0 && !categoryMatchesDir2(category, expectedDir)) {
        issues.push({ severity: "warning", message: `Category "${category}" does not match directory "${expectedDir}"` });
        score -= 0.5;
      }
    }
    if (!frontmatter.includes("related_initiatives:")) {
      issues.push({ severity: "info", message: "No related_initiatives linked (ok for standalone docs)" });
    }
    score = Math.max(0, Math.min(5, score));
    const passed = score >= 4;
    return { file: filePath, type: "wiki", score, issues, passed };
  }
};

// src/core/search.ts
var SearchEngine = class {
  baseDir;
  initiatives;
  wiki;
  // term -> docId -> { type, title, field, freq }
  index;
  // Metadata for filtering
  docTags;
  docStatus;
  docCategory;
  docDate;
  docType;
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.initiatives = new InitiativeManager(baseDir);
    this.wiki = new WikiManager(baseDir);
    this.index = /* @__PURE__ */ new Map();
    this.docTags = /* @__PURE__ */ new Map();
    this.docStatus = /* @__PURE__ */ new Map();
    this.docCategory = /* @__PURE__ */ new Map();
    this.docDate = /* @__PURE__ */ new Map();
    this.docType = /* @__PURE__ */ new Map();
  }
  /**
   * Tokenize text into lowercase terms on whitespace.
   */
  tokenize(text) {
    return text.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  }
  /**
   * Add a document field to the inverted index.
   */
  indexField(docId, type, title, field, text) {
    const tokens = this.tokenize(text);
    const freqMap = /* @__PURE__ */ new Map();
    for (const token of tokens) {
      freqMap.set(token, (freqMap.get(token) || 0) + 1);
    }
    for (const [term, count] of freqMap) {
      if (!this.index.has(term)) {
        this.index.set(term, /* @__PURE__ */ new Map());
      }
      const docMap = this.index.get(term);
      if (!docMap.has(docId)) {
        docMap.set(docId, { type, title, field, freq: 0 });
      }
      const entry = docMap.get(docId);
      entry.freq += count;
    }
  }
  /**
   * Build the inverted index from all initiatives and wiki entries.
   * Scans the file system every time — fast enough for <100 files.
   */
  buildIndex() {
    this.index.clear();
    this.docTags.clear();
    this.docStatus.clear();
    this.docCategory.clear();
    this.docDate.clear();
    this.docType.clear();
    for (const initiative of this.initiatives.list()) {
      const docId = initiative.id;
      this.indexField(docId, "initiative", initiative.title, "title", initiative.title);
      this.indexField(docId, "initiative", initiative.title, "objective", initiative.objective);
      this.indexField(docId, "initiative", initiative.title, "plan", initiative.plan.map((p) => p.description).join(" "));
      this.indexField(docId, "initiative", initiative.title, "progressLog", initiative.progressLog.join(" "));
      this.docTags.set(docId, initiative.tags);
      this.docStatus.set(docId, initiative.status);
      this.docDate.set(docId, initiative.created);
      this.docType.set(docId, "initiative");
    }
    for (const entry of this.wiki.list()) {
      const docId = this.wiki.refFor(entry);
      this.indexField(docId, "wiki", entry.title, "title", entry.title);
      this.indexField(docId, "wiki", entry.title, "content", entry.content);
      this.docTags.set(docId, entry.tags);
      this.docCategory.set(docId, entry.category);
      this.docType.set(docId, "wiki");
    }
  }
  /**
   * Search the index for documents matching the query.
   * Results are ranked by total term frequency across all query tokens.
   */
  query(query, options) {
    this.buildIndex();
    const tokens = this.tokenize(query);
    if (tokens.length === 0) return [];
    const scores = /* @__PURE__ */ new Map();
    for (const token of tokens) {
      const docMap = this.index.get(token);
      if (!docMap) continue;
      for (const [docId, entry] of docMap) {
        if (!scores.has(docId)) {
          scores.set(docId, { type: entry.type, title: entry.title, score: 0, fieldScores: /* @__PURE__ */ new Map() });
        }
        const doc = scores.get(docId);
        doc.score += entry.freq;
        doc.fieldScores.set(entry.field, (doc.fieldScores.get(entry.field) || 0) + entry.freq);
      }
    }
    const results = [];
    for (const [docId, data] of scores) {
      if (options?.tags && options.tags.length > 0) {
        const tags = this.docTags.get(docId) || [];
        if (!options.tags.some((t) => tags.includes(t))) continue;
      }
      if (options?.status) {
        if (this.docStatus.get(docId) !== options.status) continue;
      }
      if (options?.category) {
        if (this.docCategory.get(docId) !== options.category) continue;
      }
      if (options?.dateFrom) {
        const date = this.docDate.get(docId) || "";
        if (date && date < options.dateFrom) continue;
      }
      if (options?.dateTo) {
        const date = this.docDate.get(docId) || "";
        if (date && date > options.dateTo) continue;
      }
      const matchedFields = Array.from(data.fieldScores.keys());
      const bestField = matchedFields.reduce((a, b) => data.fieldScores.get(a) > data.fieldScores.get(b) ? a : b, matchedFields[0]);
      const snippet = this.getSnippet(docId, bestField);
      results.push({
        type: data.type,
        id: docId,
        title: data.title,
        score: data.score,
        snippet,
        matchedFields
      });
    }
    return results.sort((a, b) => b.score - a.score);
  }
  /**
   * Get a snippet (first 180 chars) from the best-matching field for a document.
   */
  getSnippet(docId, field) {
    const tokens = [];
    for (const [term, docMap] of this.index) {
      if (docMap.has(docId) && docMap.get(docId).field === field) {
      }
    }
    if (this.docType.get(docId) === "wiki") {
      try {
        const entry = this.wiki.readByRef(docId);
        if (entry) {
          const text = field === "title" ? entry.title : entry.content;
          return text.replace(/\s+/g, " ").slice(0, 180);
        }
      } catch {
      }
    } else if (this.docType.get(docId) === "initiative") {
      try {
        const initiative = this.initiatives.findById(docId);
        if (initiative) {
          let text = "";
          if (field === "title") text = initiative.title;
          else if (field === "objective") text = initiative.objective;
          else if (field === "plan") text = initiative.plan.map((p) => p.description).join(" ");
          else if (field === "progressLog") text = initiative.progressLog.join(" ");
          return text.replace(/\s+/g, " ").slice(0, 180);
        }
      } catch {
      }
    }
    return "";
  }
};

// src/core/subagent.ts
var SubagentAssembler = class {
  assemble(initiative, wikiEntries, currentStep, options = {}) {
    const lines = [
      `# Initiative: ${initiative.title}`,
      `## Objective`,
      initiative.objective,
      ``,
      `## Plan`,
      ...initiative.plan.map((p) => {
        const statusMap = {
          "pending": "- [ ]",
          "in-progress": "- [/]",
          "done": "- [x]"
        };
        const prefix = statusMap[p.status] || "- [ ]";
        return `${prefix} ${p.description}`;
      }),
      ``
    ];
    if (initiative.handoffSummary) {
      lines.push(`## Handoff Summary`, initiative.handoffSummary, ``);
    }
    if (initiative.nextAction) {
      lines.push(`## Next Action`, initiative.nextAction, ``);
    }
    if (initiative.blockers && initiative.blockers.length > 0) {
      lines.push(`## Blockers`, ...initiative.blockers.map((b) => `- ${b}`), ``);
    }
    if (initiative.progressLog && initiative.progressLog.length > 0) {
      lines.push(`## Progress Log`, ...initiative.progressLog.map((l) => `- ${l}`), ``);
    }
    if (initiative.artifacts && initiative.artifacts.length > 0) {
      lines.push(`## Artifacts`, ...initiative.artifacts.map((a) => `- ${a}`), ``);
    }
    if (options.retrievedMemory && options.retrievedMemory.length > 0) {
      lines.push(`## Retrieved Memory`);
      for (const mem of options.retrievedMemory) {
        lines.push(`- **${mem.title}** (${mem.type}/${mem.id}) [score: ${mem.score}]`);
        if (mem.snippet) lines.push(`  ${mem.snippet}`);
      }
      lines.push(``);
    }
    if (wikiEntries.length > 0) {
      lines.push(`## Related Wiki`);
      for (const e of wikiEntries) {
        lines.push(`### ${e.title}`, e.content);
      }
      lines.push(``);
    }
    if (options.recentEvents && options.recentEvents.length > 0) {
      lines.push(`## Recent Activity`);
      for (const event of options.recentEvents) {
        const toolName = event.details?.toolName || event.type;
        lines.push(`- [${event.timestamp}] ${toolName} at ${event.step || "unknown"}`);
      }
      lines.push(``);
    }
    lines.push(`## Current Step`);
    lines.push(`You are executing the **${currentStep}** step.`);
    lines.push(`Focus on the plan items and verify against the objective.`);
    return lines.join("\n");
  }
};

// src/core/factory.ts
function createMdocsCore(projectDir, options = {}) {
  const preliminaryRoot = path13.join(projectDir, options.mdocsDirName || "mdocs");
  const fileConfig = loadProjectConfig(preliminaryRoot);
  const merged = mergeOptions(fileConfig, options);
  const mdocsRoot = path13.join(projectDir, merged.mdocsDirName || "mdocs");
  const compatibility = { ...merged.wiki?.compatibility || {}, ...merged.compatibility || {} };
  const contract = detectMdocsContract(mdocsRoot, compatibility);
  const mdocs = new MdocsManager(mdocsRoot, compatibility);
  const initiatives = new InitiativeManager(mdocsRoot, { compatibility });
  const wiki = new WikiManager(mdocsRoot, {
    standaloneCategories: merged.wiki?.standaloneCategories ?? merged.standaloneCategories,
    compatibility
  });
  const workflow = new WorkflowEngine(mdocsRoot, {
    enforcementMode: contract.enforcementMode,
    idle: contract.idle
  });
  const search = new SearchEngine(mdocsRoot);
  const audit = new AuditLog(mdocsRoot, merged.audit);
  const linter = new MdocsLinter(mdocsRoot, { initiativeRecordMode: contract.initiativeRecordMode });
  const dispatch = new SubagentAssembler();
  const lifecycle = new MdocsLifecycleService(mdocs, initiatives, merged.bootstrap);
  const commands = new MdocsCommandRegistry({
    mdocsRoot,
    mdocs,
    initiatives,
    wiki,
    workflow,
    search,
    audit,
    linter,
    dispatch,
    contract
  });
  return {
    projectDir,
    mdocsRoot,
    managers: { mdocs, initiatives, wiki, workflow, search, audit, linter, dispatch },
    lifecycle,
    commands,
    contract
  };
}
function mergeOptions(file, explicit) {
  const merged = { ...file, ...explicit };
  if (file.compatibility || explicit.compatibility) {
    merged.compatibility = { ...file.compatibility || {}, ...explicit.compatibility || {} };
  }
  if (file.wiki || explicit.wiki) {
    merged.wiki = { ...file.wiki || {}, ...explicit.wiki || {} };
  }
  if (file.audit || explicit.audit) {
    merged.audit = { ...file.audit || {}, ...explicit.audit || {} };
  }
  return merged;
}

// src/surfaces/kimi-code/translate.ts
var TOOL_NAME_MAP = {
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  LS: "list",
  List: "list",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  // Subagent dispatch tools. Both map to a non-gated pass-through; mapping
  // them keeps audit matching robust across Kimi Code versions.
  Agent: "task",
  AgentSwarm: "task",
  Task: "task"
};
var ARG_KEY_MAP = {
  file_path: "filePath",
  notebook_path: "filePath",
  path: "path",
  pattern: "pattern",
  command: "command",
  old_string: "oldString",
  new_string: "newString",
  replace_all: "replaceAll"
};
function translateToolName(kimiToolName) {
  if (kimiToolName in TOOL_NAME_MAP) return TOOL_NAME_MAP[kimiToolName];
  return kimiToolName.toLowerCase();
}
function translateArgs(toolInput) {
  const out = {};
  if (!toolInput) return out;
  for (const [key, value] of Object.entries(toolInput)) {
    const mapped = ARG_KEY_MAP[key] ?? key;
    if (!(mapped in out)) out[mapped] = value;
  }
  return out;
}
function parseHookStdin(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}
function toCore(payload) {
  return {
    toolName: translateToolName(payload.tool_name ?? ""),
    toolArgs: translateArgs(payload.tool_input)
  };
}

// src/surfaces/kimi-code/cli/pre-tool-use.ts
function readStdin() {
  return new Promise((resolve4) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve4(data));
    process.stdin.on("error", () => resolve4(data));
  });
}
async function runPreToolUse() {
  const raw = await readStdin();
  const payload = parseHookStdin(raw);
  if (!payload) return;
  const { toolName, toolArgs } = toCore(payload);
  const projectDir = resolveProjectRoot(payload.cwd || process.cwd());
  const core = createMdocsCore(projectDir);
  const allowed = core.managers.workflow.canExecuteTool(toolName, toolArgs);
  if (allowed) return;
  const step = core.managers.workflow.getCurrentStep();
  process.stderr.write(
    `mdocs workflow gate: "${toolName}" is blocked at step ${step}. Advance the workflow (e.g. reach PLAN before edits), or operate on ./mdocs/ files which are always allowed.
`
  );
  process.exit(2);
}
if (require.main === module) {
  runPreToolUse().catch(() => {
    process.exit(0);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runPreToolUse
});
//# sourceMappingURL=pre-tool-use.js.map
