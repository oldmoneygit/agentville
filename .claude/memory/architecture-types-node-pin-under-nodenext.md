---
name: architecture-types-node-pin-under-nodenext
description: Why tsconfig pins `types: ["node"]` — an ESM-flagged transitive @types package silently kills global type inclusion under NodeNext.
metadata:
  type: architecture
---

`tsconfig.json` sets `"types": ["node"]`. Removing it produces ~49 errors like
`Cannot find name 'fs'/'Buffer'/'__dirname'` across ~19 files. The cause is a
transitive `@types/chai` (pulled in by vitest) whose `package.json` declares
`"type": "module"`: under `moduleResolution: "NodeNext"`, that breaks the
automatic inclusion of **every** `@types/*` package as ambient globals.
Verified against both `@types/node@18` and `@types/node@24` — it is not a
`@types/node` version problem, so bumping that does not fix it.

**Why:** the failure looks exactly like a missing/corrupt `@types/node`, which
sends you to reinstall it instead of to the real culprit. `@types/vscode` keeps
working throughout, because a named `import 'vscode'` resolves through a
different path — that asymmetry is the tell.

**How to apply:** never "clean up" that `types` array while `moduleResolution`
is `NodeNext`. After any vitest/test-tooling upgrade, if `tsc --noEmit` starts
reporting missing Node globals, look for a new ESM-flagged `@types/*` in the
tree rather than at `@types/node`. Note also that `npm audit`/`npm install`
peer conflicts against `@types/node` are a separate issue: keeping it aligned
with the Node major in CI (24) is what removed the need for a
`legacy-peer-deps` `.npmrc`. See [[architecture-no-public-transcript-schema]].
