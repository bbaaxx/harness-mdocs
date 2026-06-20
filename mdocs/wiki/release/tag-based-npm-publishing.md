---
id: "tag-based-npm-publishing"
title: "Tag-based npm publishing"
category: "release"
created: "2026-06-20"
updated: "2026-06-20"
related_initiatives: ["add-tag-based-npm-publishing"]
tags: ["release","npm","publishing","github-actions","provenance"]
lifecycle: "stable"
---

# Tag-based npm publishing

Phase 2 publishing uses `.github/workflows/publish.yml`.

## Trigger

- Push a version tag matching `v*`, for example `v0.4.1`.
- Optional manual dispatch accepts a `tag` input and checks out that tag.

## Gates

- Job uses the `release` GitHub environment for approval/secrets.
- Job runs on Node 24.
- Job runs `npm run release:check` before publishing.
- Tag must match `package.json` version exactly as `v${version}`.
- Workflow checks npm registry and fails if the version is already published.

## Auth and provenance

Required GitHub secret:

- `NPM_TOKEN` in the `release` environment or repository secrets.

Workflow permissions:

- `contents: read`
- `id-token: write` for npm provenance.

Publish command:

```bash
npm publish --provenance --access public
```

## Release flow

1. Merge/rebase release prep onto `main`.
2. Ensure `package.json` version is bumped and not already on npm.
3. Push `main` and wait for Release Check.
4. Create and push matching tag, e.g. `git tag v0.4.1 && git push origin v0.4.1`.
5. Approve the `release` environment if required.
6. Confirm npm package version appears after publish.

`release-check.yml` no longer runs on tags after Phase 2 to avoid duplicate tag workflows and duplicate release environment approvals.
