---
id: "ci-warning-log-hygiene"
title: "CI warning log hygiene"
category: "release"
created: "2026-06-19"
updated: "2026-06-19"
related_initiatives: ["quiet-ci-warning-logs"]
tags: ["ci","github-actions","warnings","dependencies","logs"]
lifecycle: "stable"
---

# CI warning log hygiene

When GitHub Actions logs show noisy but non-actionable warnings:

- Prefer dependency upgrades first. Jest 30 moves core Jest glob usage from `glob@7` to `glob@10`, though `ts-jest -> babel-plugin-istanbul -> test-exclude@6` can still keep `glob@7`/`inflight` in the install tree.
- Use `npm ci --loglevel=error` in CI to hide npm install deprecation chatter while preserving install failures and test/runtime output.
- Scope `NODE_OPTIONS=--no-deprecation` to action wrapper steps such as `actions/checkout` and `actions/setup-node` when warnings come from action internals. Do not apply it to test or quality steps if runtime deprecations should remain visible.
- `actions/checkout` can emit Git's initial-branch hint because it runs `git init` before checkout. Add a pre-checkout step in each job:

```yaml
- name: Configure Git default branch
  run: git config --global init.defaultBranch main
```

Validation pattern:

1. Run `actionlint .github/workflows/ci.yml .github/workflows/release-check.yml` locally.
2. Run quality/release checks locally if dependency or script behavior changed.
3. Push main and staging.
4. Search GitHub run logs for `deprecated|warning|forced to run|punycode|url.parse|npm warn|suppress this warning`.

Known benign search hits after cleanup:

- JSON validation output containing `"warnings": []`.
- Tar command flags like `--warning=no-unknown-keyword` from setup actions.
