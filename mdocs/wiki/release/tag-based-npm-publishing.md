---
id: "tag-based-npm-publishing"
title: "Tag-based npm publishing"
category: "release"
created: "2026-06-20"
updated: "2026-06-20"
related_initiatives: ["add-tag-based-npm-publishing","publish-harness-mdocs-0-4-1","sync-github-releases-with-npm-publishing"]
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
- Workflow checks npm registry and skips `npm publish` if the version is already published, so reruns can still create a missing GitHub Release.
- Workflow creates the matching GitHub Release after npm publish succeeds or is already present.

## Trusted publishing and provenance

Publishing uses npm Trusted Publishers/OIDC, not a long-lived npm token.

Configure this package on npmjs.com:

- Publisher: GitHub Actions
- Organization/user: `bbaaxx`
- Repository: `harness-mdocs`
- Workflow filename: `publish.yml`
- Environment name: `release`
- Allowed action: `npm publish`

This Trusted Publisher is configured for `harness-mdocs`. Package publishing access is set to require 2FA while disallowing traditional tokens.

`package.json` includes `repository.url` matching this GitHub repository, which npm trusted publishing checks during publish.

Workflow permissions:

- `contents: write` for GitHub Release creation.
- `id-token: write` for npm OIDC.

Trusted publishing requires GitHub-hosted runners, Node 22.14+ and npm 11.5.1+. The workflow runs on Node 24.

With GitHub trusted publishing for a public package from a public repository, npm automatically generates provenance. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` is required for publishing.

Publish command:

```bash
npm publish --access public
```

## Release flow

1. Merge/rebase release prep onto `main`.
2. Ensure `package.json` version is bumped and not already on npm.
3. Push `main` and wait for Release Check.
4. Create and push matching tag, e.g. `git tag v0.4.1 && git push origin v0.4.1`.
5. Approve the `release` environment if required.
6. Confirm npm package version appears after publish.
7. Confirm GitHub Releases shows the same tag/version.

`release-check.yml` no longer runs on tags after Phase 2 to avoid duplicate tag workflows and duplicate release environment approvals.
