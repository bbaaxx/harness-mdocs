# Issue #8 acceptance map

The original issue spans shipped 0.8.x fixes and new opt-in compiled-view work.
This checklist records executable coverage; it is not a claim of a consumer
deployment smoke test or permission to close the GitHub issue.

| Acceptance | Implementation / regression coverage |
| --- | --- |
| 1. Unknown wiki frontmatter/body preserved | `tests/core/lossless-metadata-only-mutations.test.ts` |
| 2. Both metadata-only link sides persisted | Same suite, bidirectional read-back test |
| 3. Status, sources, path ID, singular category preserved | Same suite, ingest updatePage test |
| 4. Own compiled page is provenance, not a self-link | Same suite, self-link no-op test |
| 5. Directory initiative registration | `tests/core/compiled-views.test.ts`, creation follow-ups and directory index registration |
| 6. Opt-in targeted upserts; default read-only external views | Same suite, skip/no-write, CRLF/curated rows, idempotency and marked-row refresh tests |
| 7. Second-half link failure rollback | `tests/core/lossless-metadata-only-mutations.test.ts`; compiled-view batch rollback separately covered |
| 8. Unsupported update fields fail explicitly | Same suite, unsupported initiative/wiki updates |
| 9. Mutation postconditions | Same suite and compiled-view read-back membership tests; unrelated body bytes protected by `flat-initiative-preservation.test.ts` |
| 10. Integrity diagnostics | `tests/core/validation-diagnostics.test.ts` and `tests/core/linter.test.ts` |

`index.sync` now distinguishes regenerated paths from skipped external views.
See `user-manual.md` for `compiledViewMutationMode: targeted`, registration
payloads, explicit creation follow-ups, row ownership, and rollback limits.

Remaining acceptance activity before closing: run against the reporting
consumer's curated schema and confirm its desired placement/annotation policy.
Targeted registration deliberately leaves existing curated rows untouched;
only package-marked rows receive metadata refreshes.
