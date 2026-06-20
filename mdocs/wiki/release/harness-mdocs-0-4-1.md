---
id: "harness-mdocs-0-4-1"
title: "harness-mdocs 0.4.1 release"
category: "release"
created: "2026-06-20"
updated: "2026-06-20"
related_initiatives: ["publish-harness-mdocs-0-4-1"]
tags: ["release","npm","version-0.4.1","trusted-publishing"]
lifecycle: "stable"
---

# harness-mdocs 0.4.1 release

Published `harness-mdocs@0.4.1` to npm using the tag-based GitHub Actions Publish workflow and npm Trusted Publishers/OIDC.

## Release commit and tag

- Release prep commit: `fcba9da chore(release): prepare 0.4.1`
- Git tag: `v0.4.1`
- Publish workflow run: `27881625591`

## Validation

Local and CI validation passed before tag publish:

- `npm run release:check`
- GitHub Release Check on `main`: `27881588464`
- GitHub CI on `staging`: `27881589274`

Publish workflow gates passed:

- Tag/package version match
- `npm run release:check`
- Existing version guard confirmed `0.4.1` was not published
- `npm publish --access public` via Trusted Publisher/OIDC

## npm verification

`npm view harness-mdocs@0.4.1 version dist.integrity dist.tarball --json` returned:

- Version: `0.4.1`
- Tarball: `https://registry.npmjs.org/harness-mdocs/-/harness-mdocs-0.4.1.tgz`
- Integrity: `sha512-0M1h8Rpj0TyFxpCRRGU5F15zso6cINKZBjiytxStTb6t+YW56ygcHj3rVaZhJcY4rrBmt24A4f9CgA6MPb89OA==`

## Notes

The first local release check failed because Claude plugin metadata still declared `0.4.0`. Release prep updated both package metadata and Claude plugin metadata to `0.4.1` before the successful release check.
