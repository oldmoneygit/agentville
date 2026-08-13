---
name: architecture-import-graph-lint-rules-fail-silent
description: Import-graph lint rules (import-x/no-cycle, boundaries) report nothing when misconfigured, which is indistinguishable from clean code — always probe them with a deliberate violation.
metadata:
  type: architecture
---

`import-x/no-cycle` sat in `eslint.config.mjs` for several releases finding nothing: import-x
cannot parse `.ts` without `import-x/extensions` + `import-x/parsers`, so its import graph was
empty and every real cycle passed. Enabling them exposed 3 pre-existing cycles immediately.
Two sibling traps: `eslint-plugin-import-x` v4 only honours a resolver instance under
`import-x/resolver-next` (the legacy `import-x/resolver` object is ignored), and
`eslint-plugin-boundaries`' `dependencies` rule defaults `checkAllOrigins: false`, silently
skipping every external import — so a policy banning the `vscode` package never runs.

**Why:** all three fail _open_ and produce zero output, so a green lint run is not evidence
the rule works. Reading the config shows the rule present and looking correct.

**How to apply:** never trust a newly added import-graph rule until a deliberate violation
makes it fail. `src/test/lintRules.test.ts` holds those probes — extend it when adding
another such rule. Same lesson as [[architecture-fixtures-hide-real-log-shapes]].
