#!/usr/bin/env node
/**
 * Claude Code SessionStart hook entrypoint, invoked via:
 *   node <pkg>/dist/cli/hooks/session-start.js
 *
 * Contract (verified against https://code.claude.com/docs/en/hooks):
 *   stdin  = SessionStart payload JSON (session_id, cwd, source, transcript_path, ...)
 *   stdout = JSON in the form
 *            {"hookSpecificOutput":{"hookEventName":"SessionStart",
 *                                   "additionalContext":"<markdown string>"}}
 *            — the additionalContext string is injected into the session at
 *            the start of the conversation, before the first prompt. Output
 *            is only processed on exit 0. SessionStart also accepts plain
 *            stdout text as context, but we emit the JSON form so the shape
 *            is unambiguous and forward-compatible with other event fields.
 *   exit 0 = always (SessionStart has no blocking control).
 *
 * FAIL OPEN: any error in this hook exits 0 with NO additionalContext.
 * A translator/parser bug must never wedge the session by emitting broken
 * JSON or hanging on startup. The orientation banner is best-effort.
 */
import { sessionContext } from '../../core';
/**
 * Format the sessionContext snapshot as a compact markdown orientation
 * banner. Kept short — additionalContext is capped at 10,000 chars by
 * Claude Code, and SessionStart runs on every session so the banner should
 * be a pointer, not a full dump.
 */
export declare function formatOrientationBanner(ctx: ReturnType<typeof sessionContext>): string;
export declare function runSessionStart(): Promise<void>;
