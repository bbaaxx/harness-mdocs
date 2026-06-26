"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCompleted = isCompleted;
exports.parseYamlValue = parseYamlValue;
exports.parseFrontmatter = parseFrontmatter;
exports.readExpectedDurationRaw = readExpectedDurationRaw;
/**
 * True for any status that means "completed".
 * `done` is the flat-v1 alias; `complete` is the directory-v2 canonical value.
 * Both surface the same semantic completion state.
 *
 * Accepts a raw `string` in addition to `Status` because some callers (e.g. the
 * linter) hold initiative status as an untyped string; the comparison only
 * ever matches the two completed values, so unknown strings simply return false.
 */
function isCompleted(status) {
    return status === 'done' || status === 'complete';
}
/**
 * Parse a YAML frontmatter value that may be JSON (`["a","b"]`) or
 * YAML inline array (`[a, b, c]`) or a plain scalar.
 */
function parseYamlValue(raw) {
    const trimmed = raw.trim();
    if (trimmed === '')
        return '';
    // 1. Try JSON first (covers quoted arrays, numbers, booleans, null)
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // not valid JSON – continue
    }
    // 2. YAML inline array: [item1, item2, ...]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const inner = trimmed.slice(1, -1).trim();
        if (inner === '')
            return [];
        return inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    }
    // 3. Plain scalar
    // Strip surrounding quotes if present
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
/**
 * Parse YAML frontmatter lines into a key-value map.
 * Handles both JSON-style values and YAML inline arrays.
 */
function parseFrontmatter(content) {
    const match = content.match(/---\r?\n([\s\S]*?)\r?\n---/);
    if (!match)
        return {};
    const front = {};
    for (const line of match[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key) {
            front[key] = parseYamlValue(value);
        }
    }
    return front;
}
/**
 * Read an initiative's expected-duration frontmatter value across the
 * supported key spellings: snake_case `expected_duration`, camelCase
 * `expectedDuration`, and the hyphenated consumer form `expected-duration`.
 * Returns `undefined` when none are present. Centralized so lifecycle and lint
 * logic honors the consumer schema without each caller re-implementing the
 * lookup.
 */
function readExpectedDurationRaw(front) {
    return front.expected_duration ?? front.expectedDuration ?? front['expected-duration'];
}
//# sourceMappingURL=types.js.map