/**
 * Dependency-free advisory lock. mkdir is atomic on POSIX and Windows, so a
 * lock directory is a portable mutex. Used to serialize the read-modify-write
 * of the active initiative file during parallel PostToolUse hooks.
 *
 * Best-effort by design: if the lock can't be acquired within the budget the
 * caller SKIPS the optional write (progress logging) rather than blocking the
 * tool. Enforcement must never hinge on this lock.
 */
import * as fs from 'fs';
import * as path from 'path';

const STALE_MS = 5_000; // a lock older than this is presumed abandoned

/**
 * Try to run `fn` while holding a lock at `<baseDir>/.<name>.lock`.
 * Returns true if the lock was acquired and `fn` ran, false on timeout.
 */
export function withLock<T>(
  baseDir: string,
  name: string,
  fn: () => T,
  opts: { timeoutMs?: number; retryMs?: number } = {}
): { ran: boolean; value?: T } {
  const lockDir = path.join(baseDir, `.${name}.lock`);
  const timeoutMs = opts.timeoutMs ?? 250;
  const retryMs = opts.retryMs ?? 15;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break; // acquired
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      // Reap a stale lock from a crashed prior holder.
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {
        // lock vanished between stat and now — retry immediately
        continue;
      }
      if (Date.now() >= deadline) return { ran: false };
      // tiny synchronous backoff; hold time is sub-ms so spins are few
      const until = Date.now() + retryMs;
      while (Date.now() < until) { /* spin */ }
    }
  }

  try {
    return { ran: true, value: fn() };
  } finally {
    try { fs.rmdirSync(lockDir); } catch { /* already gone */ }
  }
}
