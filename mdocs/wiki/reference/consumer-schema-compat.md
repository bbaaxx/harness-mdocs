---
id: "consumer-schema-compat"
title: "Consumer Schema Compatibility"
category: "reference"
created: "2026-06-24"
updated: "2026-06-24"
related_initiatives: ["consumer-schema-compat","cc0-config-and-contract-foundation","cc1-metadata-only-initiative","cc2-linter-consumer-tolerance","cc3-wiki-id-and-emitters","cc4-docs-and-dogfood","prepare-release-0-5-1"]
tags: ["compat","contract","consumer-schema","config"]
lifecycle: "stable"
---

# Consumer Schema Compatibility

harness-mdocs honors a consumer mdocs tree that uses a thinner schema than it authors by default, **without any consumer data migration**. Every behavior is opt-in via a `.mdocs.json` file in the mdocs root and defaults to current behavior.

## Consumer schema

- Metadata-only initiative `_status.md`: lifecycle frontmatter + prose, artifacts in sibling files (no injected `## Objective` / `## Plan` / `## Progress Log`).
- Wiki pages with path-style frontmatter `id` (`systems/foo`), singular `category` (`system`), and hyphenated `expected-duration`.

## Opt-in: .mdocs.json

```json
{
  "compatibility": { "initiativeRecordMode": "metadata-only", "enforcementMode": "advisory" },
  "standaloneCategories": ["repos", "systems", "glossary"]
}
```

## initiativeRecordMode: metadata-only

- `_status.md` writes are surgical: only lifecycle keys (status/updated/completed/graduated) are added or updated; structural keys (id/title/owner/related_wiki/tags) are never injected; inline `tags: [a, b]` formatting is preserved.
- PostToolUse records audit only; it does not mutate `_status.md`.
- The linter skips initiative body-section and required-field deductions while keeping lifecycle telemetry (long-running-active, stale-complete, graduation-due).

## Wiki identity + emitters

- Canonical id/ref resolve by filename stem + parent-directory category, so `wiki/systems/foo.md` with `id: systems/foo, category: system` resolves backlinks from `related_wiki: ["systems/foo"]`.
- `appendLog` emits `## [YYYY-MM-DD] {operation} | {subject}` when both operation and subject are supplied; the legacy `## {timestamp}` form is preserved otherwise.

## Config precedence

env > `.mdocs.json` file > detected contract. The `file` precedence tier is implemented in `src/core/config.ts` (`loadProjectConfig`); the resolved contract is exposed on `MdocsCore.contract`.

## Invariant

An unconfigured tree is untouched. Defaults reproduce prior behavior exactly, so existing tests stay green unless a path is intentionally exercised under `metadata-only`.
