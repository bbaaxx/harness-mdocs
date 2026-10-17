# harness-mdocs 2.2.0

Minor release: backward-compatible, opt-in curated-view registration plus fixes
for issues [#8](https://github.com/bbaaxx/harness-mdocs/issues/8),
[#9](https://github.com/bbaaxx/harness-mdocs/issues/9),
[#10](https://github.com/bbaaxx/harness-mdocs/issues/10), and
[#11](https://github.com/bbaaxx/harness-mdocs/issues/11).

## Added

- Directory-v2 consumers can explicitly opt into targeted registration of one
  initiative, wiki page, or active-initiative overview row using `index.sync` and
  `compatibility.compiledViewMutationMode: "targeted"`.
- Existing curated rows and annotations remain untouched. Missing rows are
  appended with package ownership markers; subsequent upserts refresh only
  marked rows. The batch preflights all requests, verifies membership from disk,
  and reports rollback outcomes if a write or postcondition fails.
- Directory initiative and externally owned wiki creation return explicit
  `requiredFollowUps` rather than implying compiled views were updated.

## Fixed

- **Flat initiative data loss (#11):** updates no longer rebuild the entire
  document from an incomplete model or silently rename existing files. Custom
  frontmatter, unknown sections, wrapped/lazy list entries, fenced examples,
  CRLF, and Markdown hard-break spaces survive updates. Completion, graduation,
  and wiki linking use the preserving writer. Atomic replacement protects the
  original if the replacement write fails.
- **Consumer wiki preservation (#8):** metadata-only updates retain original
  body bytes. Managed backlinks no longer truncate a following consumer appendix;
  CRLF frontmatter is parsed correctly.
- **Kimi MCP startup (#10):** the manifest's portable Node launcher resolves the
  managed plugin bundle under `KIMI_CODE_HOME` (default `~/.kimi-code`) without
  changing project cwd. This prevents `MODULE_NOT_FOUND` from a project-relative
  bundle path and keeps memory scoped to the correct project.
- **Command schemas (#9):** one canonical frozen allowlist supplies OpenCode,
  Claude/Kimi MCP, and pi command enums. Unknown runtime commands return
  `{ success: false, code: "INVALID_COMMAND", retryable: true, command, error,
  supportedCommands }`. MCP schema bypasses are rejected before constructing
  project state. Existing error signaling is preserved.
- **Index results (#8):** externally owned views are reported as skipped rather
  than regenerated when no writes occurred.
- **Release reliability:** the authority settlement regression test freezes only
  the replacement deadline while inspecting fenced claims; intentionally hung
  attempts still exercise real timeout behavior. Production authority code is
  unchanged.

## Upgrade

Install `harness-mdocs@2.2.0`, update pinned plugin versions, and restart the host.
Kimi users must reinstall the plugin from the updated package and then `/reload`;
updating the package alone does not replace Kimi's managed copy.

No data migration or dependency changes. Existing tool names and package
entrypoints remain unchanged. Default external ownership remains read-only;
the new targeted writes require separate explicit configuration **and** an
explicit registration request. Production Run remains plan-only.

Use the returned initiative filename rather than expecting updates to rename a
legacy file. The preservation fix prevents future losses; recover content lost
under older versions from version-control history or backups.

See [User Manual](user-manual.md#targeted-registration-in-curated-views) for
configuration, payloads, row ownership, and rollback limits. Multi-file rollback
is best-effort, not crash-atomic; inspect failure results.

## Acceptance limits

- Reporting-consumer confirmation of curated placement/annotation policy and
  reinstall/reload on the affected Kimi host remain issue-closure follow-ups;
  do not infer those checks from automated artifact smoke tests.
- Dedicated high-frequency typed tools from #9 P1 are deferred.
- [Issue #8 acceptance map](issue-8-acceptance.md) separates existing shipped
  fixes, this release's targeted-view capability, and consumer confirmation.
