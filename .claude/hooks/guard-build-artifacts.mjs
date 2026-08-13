#!/usr/bin/env node
/**
 * PreToolUse guard: block edits to generated build artifacts — the esbuild bundle
 * under dist/ and packaged .vsix files. Both are produced by `npm run build` /
 * `npm run package`; hand-editing them is always a mistake.
 *
 * Wire in .claude/settings.json under PreToolUse with matcher "Edit|Write|MultiEdit".
 * Non-invasive: fails open on any I/O or parse error (exit 0).
 */
import fs from 'node:fs';

/** @returns {string} */
function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** @type {any} */
let event = {};
try {
  event = JSON.parse(readStdin() || '{}');
} catch {
  process.exit(0);
}

const filePath = String(event?.tool_input?.file_path ?? '');
if (!filePath) process.exit(0);

const isArtifact = /(^|\/)dist\//.test(filePath) || /\.vsix$/.test(filePath);
if (!isArtifact) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: [
        `guard-build-artifacts: refusing to edit generated artifact \`${filePath}\`.`,
        'dist/ is the esbuild output and *.vsix is the packaged extension — both are',
        'rebuilt by `npm run build` / `npm run package`. Edit the source under src/ instead.',
      ].join('\n'),
    },
  }),
);

process.exit(0);
