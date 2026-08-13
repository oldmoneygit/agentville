# Development Guide

Developer documentation for **AgentVille**: local setup, running the
extension, canonical commands, building a local `.vsix`, and a short architecture overview.
For what the extension does and how to install it from the store, see the
[root README](../README.md).

## Local setup

```bash
npm install
```

## Running in the Extension Development Host

Press **F5** (launch config `Run Extension`) to open a second VS Code window with the
extension loaded — it runs `npm run build` first automatically (the launch config's
`preLaunchTask`). Exercise the **AgentVille** view there against your own `~/.claude` /
`~/.gemini` logs.

## Canonical commands

```bash
npm install         # install dependencies
npm run lint        # eslint .
npm run format      # prettier --write "src/**/*.ts"
npx tsc --noEmit    # typecheck, no output emitted
npm run test        # vitest run
npm run build       # esbuild bundle → dist/extension.js
```

Also available: `npm run lint:fix`, `npm run format:check`, `npm run test:watch`, and
`npm run test:coverage`.

## Building and installing a local `.vsix`

```bash
npm run package        # bumps the patch version, then npx @vscode/vsce package --no-dependencies
```

Install the freshly built package with `--force` so it overwrites whatever is already
installed, then reload the window (Command Palette → _Developer: Reload Window_):

```bash
# Antigravity
antigravity-ide --install-extension agentville-*.vsix --force

# VS Code
code --install-extension agentville-*.vsix --force
```

For a clean upgrade instead of `--force`, bump `version` in `package.json` first.

## Architecture overview

Single-tree VS Code extension. Pipeline: scan log files → parse JSONL → detect subagents →
dedupe/nest → render tree. All source lives under `src/`:

- **extension.ts** — activation entrypoint; registers the tree view and commands, gates
  monitoring on the `agentville.enabled` setting.
- **sessionTreeDataProvider.ts** — orchestrator and `TreeDataProvider`: owns the session map,
  file watchers, the refresh timer, and active-status detection.
- **sessionScanner.ts** — discovers Claude Code and Antigravity log files on disk.
- **logParser.ts** — incremental JSONL parser (caches a per-file byte offset, reads only
  appended bytes); delegates title, subagent, and project-path extraction.
- **projectPathResolver.ts** / **nameExtractor.ts** — work out which project a transcript
  belongs to, and derive the session title from the first real user prompt.
- **subagentDetector.ts** — detects subagent start/stop across both brands' log shapes.
- **subagentMetadata.ts** — enriches subagent rows with their real agent name and model from
  the metadata sidecar Claude Code writes next to each subagent's transcript.
- **sessionActivity.ts** / **sessionDedupe.ts** / **sessionAssembly.ts** — decide whether a
  session is still working, then dedupe and rank sessions (including folding background
  agents under the session that launched them) for display.
- **treeItems.ts** — the `vscode.TreeItem` subclasses rendered in the view.
- **types.ts** — the `Session` / `SubAgent` domain shapes.

Parsing and detection modules (`logParser`, `subagentDetector`, `subagentMetadata`,
`sessionScanner`, `sessionActivity`, `sessionAssembly`, `sessionDedupe`,
`projectPathResolver`, `nameExtractor`) never import `vscode` and are unit-tested under
`src/test/`; only `extension.ts`, `sessionTreeDataProvider.ts`, and `treeItems.ts` touch the
VS Code API.

## Claude Code compatibility

The transcript parser depends on Claude Code's own JSONL log format, which is undocumented
and can change between releases. `KNOWN_COMPATIBLE_CLAUDE_VERSION` in
[`src/claudeCompat.ts`](../src/claudeCompat.ts) pins the last Claude Code release the parser
was actually validated against.

Claude Code stamps a `version` field on every transcript line. When a session's `version` is
newer than the pinned constant, the extension shows the user a one-time warning that the
transcript format hasn't been re-checked against that release yet.

When you validate the parser against a new Claude Code release:

1. Bump `KNOWN_COMPATIBLE_CLAUDE_VERSION` in `src/claudeCompat.ts`.
2. Update the "Last validated against" line in the [root README](../README.md).

## Releasing

Building a local `.vsix` above is for testing. For an actual release — bumping the version,
publishing to Open VSX, and cutting a GitHub Release — see [PUBLISHING.md](PUBLISHING.md).
