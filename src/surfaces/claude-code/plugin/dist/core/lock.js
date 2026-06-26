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
exports.withLock = withLock;
/**
 * Dependency-free advisory lock. mkdir is atomic on POSIX and Windows, so a
 * lock directory is a portable mutex. Used to serialize the read-modify-write
 * of the active initiative file during parallel PostToolUse hooks.
 *
 * Best-effort by design: if the lock can't be acquired within the budget the
 * caller SKIPS the optional write (progress logging) rather than blocking the
 * tool. Enforcement must never hinge on this lock.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const STALE_MS = 5_000; // a lock older than this is presumed abandoned
/**
 * Try to run `fn` while holding a lock at `<baseDir>/.<name>.lock`.
 * Returns true if the lock was acquired and `fn` ran, false on timeout.
 */
function withLock(baseDir, name, fn, opts = {}) {
    const lockDir = path.join(baseDir, `.${name}.lock`);
    const timeoutMs = opts.timeoutMs ?? 250;
    const retryMs = opts.retryMs ?? 15;
    const deadline = Date.now() + timeoutMs;
    while (true) {
        try {
            fs.mkdirSync(lockDir);
            break; // acquired
        }
        catch (err) {
            if (err?.code !== 'EEXIST')
                throw err;
            // Reap a stale lock from a crashed prior holder.
            try {
                const age = Date.now() - fs.statSync(lockDir).mtimeMs;
                if (age > STALE_MS) {
                    fs.rmdirSync(lockDir);
                    continue;
                }
            }
            catch {
                // lock vanished between stat and now — retry immediately
                continue;
            }
            if (Date.now() >= deadline)
                return { ran: false };
            // tiny synchronous backoff; hold time is sub-ms so spins are few
            const until = Date.now() + retryMs;
            while (Date.now() < until) { /* spin */ }
        }
    }
    try {
        return { ran: true, value: fn() };
    }
    finally {
        try {
            fs.rmdirSync(lockDir);
        }
        catch { /* already gone */ }
    }
}
//# sourceMappingURL=lock.js.map