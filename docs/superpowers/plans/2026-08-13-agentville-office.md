# AgentVille — The Office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn AgentVille's tree view into a living 2D pixel office — a Phaser-rendered webview in an editor tab where every running Claude Code / Antigravity session and subagent is a character with a live action bubble and a clickable activity feed.

**Architecture:** The extension keeps owning session state (`SessionTreeDataProvider`) and gains pure modules that extract a current action and a bounded recent-activity buffer from transcripts. It posts full JSON snapshots to a webview. Inside the webview, pure TypeScript decides the simulation (who exists, where they are, where they walk); Phaser only draws it, and DOM overlays handle bubbles and the side panel.

**Tech Stack:** TypeScript, esbuild (two bundles: Node extension + browser webview), Phaser 3, vitest, ESLint (`boundaries`, `import-x`, `sonarjs`, prettier).

**Spec:** `docs/superpowers/specs/2026-08-13-agentville-office-design.md`

## Global Constraints

- **ESLint `max-lines: 355`** (skipping blanks/comments) — every file must stay under it.
- **Coverage gate:** statements 80%, branches 65%, functions 80%, lines 80%. `vitest.config.ts` uses `include: ['src/**/*.ts']`, so any new non-testable file (vscode glue, Phaser, DOM) MUST be added to `coverage.exclude` or it counts as 0%.
- **Parsing never throws.** Every `fs` / `JSON.parse` in new code is wrapped in try/catch that calls `logDebug` and returns an empty/fallback value.
- **`vscode` stays out of the core.** Only `extension.ts`, `sessionTreeDataProvider.ts`, `treeItems.ts`, `subagentTreeChildren.ts` and the new `officePanel.ts` may import it.
- **Webview simulation must not import Phaser or touch the DOM.**
- **User-facing strings are English.** Code, identifiers, comments and docs are English too.
- **Assets must be CC0 or equivalently permissive** — the repo is public under Apache-2.0.
- **Release workflow fails if the `.vsix` exceeds 2 MB.** Phaser lands ~1.2 MB; re-check after Task 7.
- **Ring buffer:** 20 entries per agent, each `text` truncated to 2000 chars, max 50 agents tracked.
- **Visible character cap:** 24; overflow is reported as a count, never silently dropped.
- Run `npx tsc --noEmit`, `npm run lint`, `npm run test` before considering any task done.

---

## File Structure

Extension side (flat under `src/`, matching the project's existing layout — the `boundaries` core glob is `src/!(extension|sessionTreeDataProvider|treeItems|subagentTreeChildren).ts`, which only matches direct children):

| File                              | Responsibility                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/officeTypes.ts`              | Shared wire types (`AgentView`, `FeedEntry`, `ToWebview`, `ToExtension`). Imported by both bundles. No logic. |
| `src/activityExtractor.ts`        | Transcript entry → human-readable current action string. Pure.                                                |
| `src/recentEntries.ts`            | Per-agent ring buffer of the last 20 entries. Pure.                                                           |
| `src/subagentTranscriptReader.ts` | Incremental reader for `<session-dir>/subagents/agent-<id>.jsonl`. Pure.                                      |
| `src/officeSnapshot.ts`           | `Session[]` → `AgentView[]` with cap and ordering. Pure.                                                      |
| `src/officePanel.ts`              | Webview panel lifecycle, CSP, asset URIs, message pump. Imports `vscode`.                                     |
| `src/sessionTreeDataProvider.ts`  | _Modified:_ gains `getSessions()` and `onDidChangeSessions`.                                                  |
| `src/extension.ts`                | _Modified:_ registers `agentville.openOffice`.                                                                |

Webview side (`src/webview/`, bundled separately for the browser):

| File                                   | Responsibility                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/webview/simulation/population.ts` | Reconciles a snapshot against the current cast: who spawns, who despawns, who updates. Pure.       |
| `src/webview/simulation/movement.ts`   | Per-character walk targets and position stepping. Pure.                                            |
| `src/webview/simulation/world.ts`      | The authored office map (ASCII layout), tile lookup, walkability, door tile, depth ordering. Pure. |
| `src/webview/render/officeScene.ts`    | Phaser scene: paints the furnished tilemap once, then draws characters each frame.                 |
| `src/webview/ui/nameTags.ts`           | DOM name label under every character, always visible.                                              |
| `src/webview/ui/bubbles.ts`            | DOM speech bubbles anchored to sprite screen positions.                                            |
| `src/webview/ui/feedPanel.ts`          | DOM side panel rendering `FeedEntry[]`.                                                            |
| `src/webview/main.ts`                  | Bootstrap: wires message pump → simulation → render + UI.                                          |

Tests: `src/test/<module>.test.ts`, matching the existing naming.

---

### Task 1: Asset baseline and premium override

The reference experience is Gather, whose look depends on a modern-interior tileset — exactly where permissive licensing is weakest. Two tiers keep the public repo legal and unblocked while leaving room for a commercial pack later.

| Directory                   | Contents                | Git            | Role                                                             |
| --------------------------- | ----------------------- | -------------- | ---------------------------------------------------------------- |
| `resources/office/`         | CC0 / public-domain set | committed      | Baseline. Makes the public repo build and run for anyone.        |
| `resources/office-premium/` | commercial pack         | **gitignored** | Optional local override, copied over the baseline at build time. |

**Files:**

- Create: `resources/office/` (tiles + character sprite sheets)
- Create: `resources/office/LICENSE-ASSETS.txt`
- Create: `resources/ASSETS.md`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: nothing
- Produces: sprite sheet filenames and frame layout, documented in `resources/ASSETS.md`, consumed by Tasks 9 and 10. **Both tiers must share identical filenames, tile size and frame layout** — no code ever branches on which tier is active.

- [ ] **Step 1: Find a CC0 baseline pack**

Search for a CC0 (or equivalently permissive — CC0, Unlicense, public domain) top-down interior pack. Kenney (kenney.nl) is the primary candidate: everything there is CC0 and includes top-down characters with 4-direction walk cycles. OpenGameArt filtered to CC0 is the secondary source.

Required contents:

- floor and wall tiles
- office furniture: desk, chair, shelf, printer, plant, table, sofa, rug
- at least **two** character sprite sets, each with 4-direction walk cycles

- [ ] **Step 2: Verify the baseline licence in writing**

Locate the pack's licence file. Confirm it permits redistribution in a public repository AND inside a packaged `.vsix`, with no non-commercial clause.

**If no pack satisfies this, STOP and escalate.** Do not substitute the commercial pack — it is explicitly forbidden from the repository.

- [ ] **Step 3: Place the baseline assets**

Copy only the sprites actually needed into `resources/office/`. Do not vendor the whole pack.

Required filenames — the premium tier must mirror them exactly:

- `resources/office/tiles.png` — 16×16 tileset
- `resources/office/characters.png` — 16×24 frames, 4 directions × 4 walk frames per character set, sets stacked vertically

- [ ] **Step 4: Gitignore the premium tier**

Append to `.gitignore`:

```
# Commercial office tileset — licensed per developer, never redistributed.
# Optional local override: when present, the build copies it over resources/office/.
resources/office-premium/
```

- [ ] **Step 5: Document provenance and the unresolved licence question**

Create `resources/ASSETS.md`:

```markdown
# Office assets

## Baseline (shipped)

| Asset                   | Source              | Licence |
| ----------------------- | ------------------- | ------- |
| `office/tiles.png`      | <pack name and URL> | CC0 1.0 |
| `office/characters.png` | <pack name and URL> | CC0 1.0 |

Full licence text: `resources/office/LICENSE-ASSETS.txt`

## Sprite sheet layout

- `tiles.png` — 16×16 tiles, <N> columns
- `characters.png` — 16×24 frames, 4 directions × 4 walk frames per character set,
  character sets stacked vertically

## Premium override (local only, NOT in this repository)

Dropping a licensed commercial pack into `resources/office-premium/`, using the same
filenames and layout as above, makes the build use it instead of the baseline. The
directory is gitignored.

**Status: not cleared for release.** The candidate pack (LimeZu _Modern Interiors_)
permits "edit and use the asset in any commercial or non commercial project" and forbids
"resell or distribute the asset to others". A `.vsix` is a plain ZIP with extractable
PNGs, which sits between those two clauses.

Before any release ships a commercial pack:

1. Obtain written confirmation from the pack's author that bundling in a freely
   distributed VS Code extension is permitted.
2. Record that confirmation — date, channel, exact wording — in this file.
3. Add the required credit and link to `NOTICE` and `README.md`.

Until all three are done, releases ship the CC0 baseline.
```

Copy the baseline pack's licence text verbatim into `resources/office/LICENSE-ASSETS.txt`.

- [ ] **Step 6: Commit**

```bash
git add resources/office resources/ASSETS.md .gitignore
git commit -m "chore: vendor CC0 office sprites and document the premium override"
```

---

### Task 2: Shared wire types

**Files:**

- Create: `src/officeTypes.ts`
- Modify: `vitest.config.ts` (add to `coverage.exclude`)

**Interfaces:**

- Consumes: nothing
- Produces: `AgentView`, `FeedEntry`, `ToWebview`, `ToExtension` — used by Tasks 6, 8, 9, 11.

- [ ] **Step 1: Create the types file**

```ts
// src/officeTypes.ts
// Wire format between the extension and the office webview. Shared by both bundles, so it
// must stay dependency-free — no `vscode`, no Phaser, no DOM.

export interface AgentView {
  id: string;
  kind: 'session' | 'subagent';
  parentId?: string;
  name: string;
  model?: string;
  projectName: string;
  brand: 'claude-code' | 'antigravity';
  status: 'working' | 'stopped';
  action?: string; // absent when stopped
  lastActivityAt: number;
}

export interface FeedEntry {
  role: 'assistant' | 'user';
  text: string; // truncated to MAX_ENTRY_CHARS
  tool?: string;
  at: number;
}

export type ToWebview =
  | { type: 'snapshot'; agents: AgentView[]; truncated: number }
  | { type: 'feed'; agentId: string; entries: FeedEntry[] }
  | { type: 'monitoringDisabled' };

export type ToExtension =
  | { type: 'ready' }
  | { type: 'openFeed'; agentId: string }
  | { type: 'closeFeed' }
  | { type: 'openLog'; agentId: string }
  | { type: 'openProject'; agentId: string };
```

- [ ] **Step 2: Exclude it from coverage**

It is types only — no runtime code to cover. In `vitest.config.ts`, add `'src/officeTypes.ts'` to the `coverage.exclude` array, next to the existing `'src/types.ts'` entry.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/officeTypes.ts vitest.config.ts
git commit -m "feat: add office webview wire types"
```

---

### Task 3: Current-action extractor

**Files:**

- Create: `src/activityExtractor.ts`
- Test: `src/test/activityExtractor.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `extractAction(entry: unknown): string | undefined` — used by Tasks 5 and 6.

Returns `undefined` for an entry that carries no assistant turn (so the caller keeps the previous action), a rendered action string otherwise.

- [ ] **Step 1: Write the failing test**

```ts
// src/test/activityExtractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractAction } from '../activityExtractor';

function assistantEntry(content: unknown[]): unknown {
  return { type: 'assistant', message: { role: 'assistant', content } };
}

describe('extractAction', () => {
  it('renders Read as Reading with the file basename', () => {
    const entry = assistantEntry([{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/types.ts' } }]);
    expect(extractAction(entry)).toBe('Reading types.ts');
  });

  it('renders Edit and Write as Editing', () => {
    const edit = assistantEntry([{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/logParser.ts' } }]);
    const write = assistantEntry([{ type: 'tool_use', name: 'Write', input: { file_path: '/x/new.ts' } }]);
    expect(extractAction(edit)).toBe('Editing logParser.ts');
    expect(extractAction(write)).toBe('Editing new.ts');
  });

  it('renders Bash as Running with a truncated command', () => {
    const entry = assistantEntry([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]);
    expect(extractAction(entry)).toBe('Running npm test');
  });

  it('truncates a long Bash command to 30 characters', () => {
    const long = 'npm run test -- --coverage --reporter=verbose --run';
    const entry = assistantEntry([{ type: 'tool_use', name: 'Bash', input: { command: long } }]);
    expect(extractAction(entry)).toBe(`Running ${long.slice(0, 30)}…`);
  });

  it('renders Grep and Glob as Searching', () => {
    const entry = assistantEntry([{ type: 'tool_use', name: 'Grep', input: { pattern: 'extractAction' } }]);
    expect(extractAction(entry)).toBe('Searching for extractAction');
  });

  it('renders Agent as Delegating to the subagent type', () => {
    const entry = assistantEntry([{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'debugger' } }]);
    expect(extractAction(entry)).toBe('Delegating to debugger');
  });

  it('renders TodoWrite as Planning and web tools as Researching', () => {
    expect(extractAction(assistantEntry([{ type: 'tool_use', name: 'TodoWrite', input: {} }]))).toBe('Planning');
    expect(extractAction(assistantEntry([{ type: 'tool_use', name: 'WebSearch', input: {} }]))).toBe('Researching');
  });

  it('falls back to Working for an unknown tool', () => {
    const entry = assistantEntry([{ type: 'tool_use', name: 'SomeFutureTool', input: {} }]);
    expect(extractAction(entry)).toBe('Working');
  });

  it('uses the LAST tool_use when a turn has several', () => {
    const entry = assistantEntry([
      { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ]);
    expect(extractAction(entry)).toBe('Running ls');
  });

  it('renders Thinking for an assistant turn with text but no tool_use', () => {
    const entry = assistantEntry([{ type: 'text', text: 'Let me look at this.' }]);
    expect(extractAction(entry)).toBe('Thinking');
  });

  it('returns undefined for bookkeeping entries that carry no message', () => {
    for (const type of ['attachment', 'last-prompt', 'queue-operation', 'ai-title']) {
      expect(extractAction({ type })).toBeUndefined();
    }
  });

  it('returns undefined for a user entry', () => {
    expect(extractAction({ type: 'user', message: { role: 'user', content: 'hi' } })).toBeUndefined();
  });

  it('never throws on malformed input', () => {
    for (const bad of [null, undefined, 42, 'string', {}, { message: null }, { message: { content: 'x' } }]) {
      expect(() => extractAction(bad)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/activityExtractor.test.ts`
Expected: FAIL — cannot resolve `../activityExtractor`.

- [ ] **Step 3: Write the implementation**

```ts
// src/activityExtractor.ts
// Derives the one-line "what is this agent doing right now" string shown in the office
// speech bubble, from the last tool_use of an agent's most recent assistant turn.
//
// The transcript format is undocumented and changes between Claude Code releases, so every
// access here is defensive: an unrecognised shape yields `undefined` (keep the previous
// action) or the generic 'Working', never an exception and never a raw tool id.

const MAX_COMMAND_CHARS = 30;

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The last tool_use block of an assistant turn, or undefined when there is none. */
function lastToolUse(entry: unknown): ToolUse | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const message = (entry as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: unknown; name?: unknown; input?: unknown };
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      return { name: block.name, input: (block.input as Record<string, unknown>) ?? {} };
    }
  }
  return undefined;
}

function isAssistantTurn(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const typed = entry as { type?: unknown; message?: unknown };
  // Bookkeeping entries (attachment / last-prompt / queue-operation / ai-title) trail every
  // real turn and carry no `message` — gating on `type` alone would misread them as turns.
  if (typeof typed.message !== 'object' || typed.message === null) {
    return false;
  }
  return typed.type === 'assistant';
}

function renderTool(tool: ToolUse): string {
  const { name, input } = tool;
  switch (name) {
    case 'Read': {
      const file = asString(input.file_path);
      return file ? `Reading ${basename(file)}` : 'Reading';
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const file = asString(input.file_path) ?? asString(input.notebook_path);
      return file ? `Editing ${basename(file)}` : 'Editing';
    }
    case 'Bash': {
      const command = asString(input.command);
      if (!command) {
        return 'Running a command';
      }
      const shown = command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS)}…` : command;
      return `Running ${shown}`;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = asString(input.pattern);
      return pattern ? `Searching for ${pattern}` : 'Searching';
    }
    case 'Agent':
    case 'Task': {
      const target = asString(input.subagent_type) ?? asString(input.description);
      return target ? `Delegating to ${target}` : 'Delegating';
    }
    case 'WebSearch':
    case 'WebFetch':
      return 'Researching';
    case 'TodoWrite':
      return 'Planning';
    default:
      return 'Working';
  }
}

/**
 * The current action for an agent, from one transcript entry.
 * `undefined` means "this entry says nothing about activity" — the caller keeps whatever
 * action it already had.
 */
export function extractAction(entry: unknown): string | undefined {
  try {
    if (!isAssistantTurn(entry)) {
      return undefined;
    }
    const tool = lastToolUse(entry);
    return tool ? renderTool(tool) : 'Thinking';
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/test/activityExtractor.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify the whole gate**

Run: `npx tsc --noEmit && npm run lint && npm run test`
Expected: all clean, 175 pre-existing tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/activityExtractor.ts src/test/activityExtractor.test.ts
git commit -m "feat: derive a human-readable current action from a transcript entry"
```

---

### Task 4: Recent-entries ring buffer

**Files:**

- Create: `src/recentEntries.ts`
- Test: `src/test/recentEntries.test.ts`

**Interfaces:**

- Consumes: `FeedEntry` from `src/officeTypes.ts` (Task 2)
- Produces:
  - `class RecentEntryStore`
  - `push(agentId: string, entry: FeedEntry): void`
  - `get(agentId: string): FeedEntry[]` — oldest first
  - `retain(agentIds: readonly string[]): void` — drops buffers for agents no longer present
  - constants `MAX_ENTRIES = 20`, `MAX_ENTRY_CHARS = 2000`, `MAX_AGENTS = 50`

Used by Tasks 5 and 8.

- [ ] **Step 1: Write the failing test**

```ts
// src/test/recentEntries.test.ts
import { describe, it, expect } from 'vitest';
import { RecentEntryStore, MAX_ENTRIES, MAX_ENTRY_CHARS, MAX_AGENTS } from '../recentEntries';
import type { FeedEntry } from '../officeTypes';

function entry(text: string, at = 1): FeedEntry {
  return { role: 'assistant', text, at };
}

describe('RecentEntryStore', () => {
  it('returns an empty array for an unknown agent', () => {
    expect(new RecentEntryStore().get('nope')).toEqual([]);
  });

  it('keeps entries oldest first', () => {
    const store = new RecentEntryStore();
    store.push('a', entry('first', 1));
    store.push('a', entry('second', 2));
    expect(store.get('a').map((e) => e.text)).toEqual(['first', 'second']);
  });

  it(`evicts the oldest beyond ${MAX_ENTRIES} entries`, () => {
    const store = new RecentEntryStore();
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      store.push('a', entry(`e${i}`, i));
    }
    const texts = store.get('a').map((e) => e.text);
    expect(texts).toHaveLength(MAX_ENTRIES);
    expect(texts[0]).toBe('e5');
    expect(texts[texts.length - 1]).toBe(`e${MAX_ENTRIES + 4}`);
  });

  it(`truncates text longer than ${MAX_ENTRY_CHARS} characters and marks it`, () => {
    const store = new RecentEntryStore();
    store.push('a', entry('x'.repeat(MAX_ENTRY_CHARS + 100)));
    const [stored] = store.get('a');
    expect(stored.text).toHaveLength(MAX_ENTRY_CHARS + 1);
    expect(stored.text.endsWith('…')).toBe(true);
  });

  it('leaves text at exactly the limit untouched', () => {
    const store = new RecentEntryStore();
    store.push('a', entry('x'.repeat(MAX_ENTRY_CHARS)));
    expect(store.get('a')[0].text.endsWith('…')).toBe(false);
  });

  it('drops buffers for agents not in the retain list', () => {
    const store = new RecentEntryStore();
    store.push('a', entry('keep'));
    store.push('b', entry('drop'));
    store.retain(['a']);
    expect(store.get('a')).toHaveLength(1);
    expect(store.get('b')).toEqual([]);
  });

  it(`tracks at most ${MAX_AGENTS} agents, evicting the least recently written`, () => {
    const store = new RecentEntryStore();
    for (let i = 0; i < MAX_AGENTS + 3; i++) {
      store.push(`agent-${i}`, entry('x', i));
    }
    expect(store.get('agent-0')).toEqual([]);
    expect(store.get('agent-2')).toEqual([]);
    expect(store.get(`agent-${MAX_AGENTS + 2}`)).toHaveLength(1);
  });

  it("does not mutate the caller's entry object", () => {
    const store = new RecentEntryStore();
    const original = entry('y'.repeat(MAX_ENTRY_CHARS + 10));
    store.push('a', original);
    expect(original.text).toHaveLength(MAX_ENTRY_CHARS + 10);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/recentEntries.test.ts`
Expected: FAIL — cannot resolve `../recentEntries`.

- [ ] **Step 3: Write the implementation**

```ts
// src/recentEntries.ts
// Bounded, in-memory activity buffer feeding the office side panel. Deliberately a sliding
// window rather than the whole transcript: transcripts reach tens of MB, and the panel
// answers "what is it doing now" — full history is already served by "Open Log File".

import type { FeedEntry } from './officeTypes';

export const MAX_ENTRIES = 20;
export const MAX_ENTRY_CHARS = 2000;
export const MAX_AGENTS = 50;

function truncate(text: string): string {
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…` : text;
}

export class RecentEntryStore {
  // Map preserves insertion order, and re-inserting on write makes the first key the
  // least-recently-written agent — which is what the MAX_AGENTS eviction drops.
  private readonly buffers = new Map<string, FeedEntry[]>();

  push(agentId: string, entry: FeedEntry): void {
    const existing = this.buffers.get(agentId) ?? [];
    this.buffers.delete(agentId);

    const next = [...existing, { ...entry, text: truncate(entry.text) }];
    this.buffers.set(agentId, next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next);

    if (this.buffers.size > MAX_AGENTS) {
      const oldest = this.buffers.keys().next();
      if (!oldest.done) {
        this.buffers.delete(oldest.value);
      }
    }
  }

  get(agentId: string): FeedEntry[] {
    return this.buffers.get(agentId) ?? [];
  }

  /** Drop buffers for agents that are no longer in the snapshot. */
  retain(agentIds: readonly string[]): void {
    const keep = new Set(agentIds);
    for (const id of [...this.buffers.keys()]) {
      if (!keep.has(id)) {
        this.buffers.delete(id);
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/test/recentEntries.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the whole gate**

Run: `npx tsc --noEmit && npm run lint && npm run test`

- [ ] **Step 6: Commit**

```bash
git add src/recentEntries.ts src/test/recentEntries.test.ts
git commit -m "feat: add bounded per-agent activity buffer"
```

---

### Task 5: Subagent transcript reader

The extension currently reads the session transcript and each subagent's `.meta.json` sidecar, but never the subagent's own transcript. This task adds that, incrementally.

**Files:**

- Create: `src/subagentTranscriptReader.ts`
- Test: `src/test/subagentTranscriptReader.test.ts`

**Interfaces:**

- Consumes: `extractAction` (Task 3), `FeedEntry` (Task 2)
- Produces:
  - `class SubagentTranscriptReader`
  - `read(transcriptPath: string): { action?: string; entries: FeedEntry[] }` — only newly appended bytes
  - `subagentTranscriptPath(sessionLogPath: string, agentId: string): string`

Used by Task 8.

- [ ] **Step 1: Write the failing test**

```ts
// src/test/subagentTranscriptReader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SubagentTranscriptReader, subagentTranscriptPath } from '../subagentTranscriptReader';

const tempDir = path.join(os.tmpdir(), 'agentville-subagent-test');
const filePath = path.join(tempDir, 'agent-abc.jsonl');

function assistantLine(toolName: string, input: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-13T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: toolName, input }] },
  })}\n`;
}

describe('subagentTranscriptPath', () => {
  it('resolves the subagents directory next to the session transcript', () => {
    const result = subagentTranscriptPath('/logs/proj/session-1.jsonl', 'abc');
    expect(result).toBe(path.join('/logs/proj', 'session-1', 'subagents', 'agent-abc.jsonl'));
  });
});

describe('SubagentTranscriptReader', () => {
  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(filePath, '');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty result for a missing file and does not throw', () => {
    const reader = new SubagentTranscriptReader();
    expect(reader.read(path.join(tempDir, 'nope.jsonl'))).toEqual({ action: undefined, entries: [] });
  });

  it('extracts the action from the last assistant turn', () => {
    fs.writeFileSync(filePath, assistantLine('Read', { file_path: '/a/types.ts' }));
    const reader = new SubagentTranscriptReader();
    expect(reader.read(filePath).action).toBe('Reading types.ts');
  });

  it('reads only appended bytes on a second call', () => {
    fs.writeFileSync(filePath, assistantLine('Read', { file_path: '/a/one.ts' }));
    const reader = new SubagentTranscriptReader();
    expect(reader.read(filePath).entries).toHaveLength(1);

    fs.appendFileSync(filePath, assistantLine('Bash', { command: 'npm test' }));
    const second = reader.read(filePath);
    expect(second.entries).toHaveLength(1);
    expect(second.action).toBe('Running npm test');
  });

  it('returns no new entries when nothing was appended', () => {
    fs.writeFileSync(filePath, assistantLine('Read', { file_path: '/a/one.ts' }));
    const reader = new SubagentTranscriptReader();
    reader.read(filePath);
    expect(reader.read(filePath).entries).toEqual([]);
  });

  it('re-reads from the start when the file shrinks (rotation)', () => {
    fs.writeFileSync(filePath, assistantLine('Read', { file_path: '/a/one.ts' }));
    const reader = new SubagentTranscriptReader();
    reader.read(filePath);

    fs.writeFileSync(filePath, assistantLine('Bash', { command: 'ls' }));
    expect(reader.read(filePath).entries).toHaveLength(1);
  });

  it('skips malformed lines without throwing', () => {
    fs.writeFileSync(filePath, `not json\n${assistantLine('Read', { file_path: '/a/ok.ts' })}{"broken":\n`);
    const reader = new SubagentTranscriptReader();
    const result = reader.read(filePath);
    expect(result.action).toBe('Reading ok.ts');
    expect(result.entries).toHaveLength(1);
  });

  it('ignores bookkeeping entries', () => {
    fs.writeFileSync(filePath, `${JSON.stringify({ type: 'ai-title' })}\n`);
    const reader = new SubagentTranscriptReader();
    expect(reader.read(filePath)).toEqual({ action: undefined, entries: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/subagentTranscriptReader.test.ts`
Expected: FAIL — cannot resolve `../subagentTranscriptReader`.

- [ ] **Step 3: Write the implementation**

```ts
// src/subagentTranscriptReader.ts
// Reads a subagent's own transcript — the file the tree view never needed. Subagent
// transcripts live at `<session-dir>/<session-id>/subagents/agent-<id>.jsonl`; the parent
// transcript only records the launch and the completion, so the live picture of what a
// subagent is doing exists nowhere else.
//
// Incremental by the same rule as LogParser: cache a byte offset per file and read only
// what was appended. Only WORKING subagents should be passed here — a finished subagent
// cannot produce a new action, and opening every completed one would multiply I/O by the
// number of agents the session has ever launched.

import * as fs from 'fs';
import * as path from 'path';
import { extractAction } from './activityExtractor';
import { logDebug } from './logger';
import type { FeedEntry } from './officeTypes';

export interface SubagentRead {
  action?: string;
  entries: FeedEntry[];
}

/** `/logs/proj/session-1.jsonl` + `abc` → `/logs/proj/session-1/subagents/agent-abc.jsonl` */
export function subagentTranscriptPath(sessionLogPath: string, agentId: string): string {
  const dir = path.dirname(sessionLogPath);
  const sessionId = path.basename(sessionLogPath, '.jsonl');
  return path.join(dir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

function textOf(entry: unknown): string {
  const content = (entry as { message?: { content?: unknown } })?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((b: { type?: unknown }) => b?.type === 'text')
    .map((b: { text?: unknown }) => (typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

function toFeedEntry(entry: unknown): FeedEntry | undefined {
  const typed = entry as { type?: unknown; timestamp?: unknown; message?: unknown };
  if (typed?.type !== 'assistant' && typed?.type !== 'user') {
    return undefined;
  }
  if (typeof typed.message !== 'object' || typed.message === null) {
    return undefined;
  }
  const text = textOf(entry);
  const action = extractAction(entry);
  if (!text && !action) {
    return undefined;
  }
  const at = typeof typed.timestamp === 'string' ? Date.parse(typed.timestamp) : Date.now();
  return {
    role: typed.type === 'user' ? 'user' : 'assistant',
    text: text || (action ?? ''),
    tool: action,
    at: Number.isNaN(at) ? Date.now() : at,
  };
}

export class SubagentTranscriptReader {
  private readonly offsets = new Map<string, number>();

  read(transcriptPath: string): SubagentRead {
    try {
      if (!fs.existsSync(transcriptPath)) {
        return { action: undefined, entries: [] };
      }
      const size = fs.statSync(transcriptPath).size;
      const previous = this.offsets.get(transcriptPath) ?? 0;
      // A file that shrank was rotated or rewritten — start over rather than read garbage.
      const start = size < previous ? 0 : previous;
      if (size === start) {
        return { action: undefined, entries: [] };
      }

      const fd = fs.openSync(transcriptPath, 'r');
      let chunk: string;
      try {
        const buffer = Buffer.alloc(size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        chunk = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      this.offsets.set(transcriptPath, size);

      const entries: FeedEntry[] = [];
      let action: string | undefined;
      for (const line of chunk.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(line);
          const feed = toFeedEntry(parsed);
          if (feed) {
            entries.push(feed);
          }
          action = extractAction(parsed) ?? action;
        } catch {
          // A partially-written trailing line is normal while an agent is mid-append.
        }
      }
      return { action, entries };
    } catch (error) {
      logDebug(`SubagentTranscriptReader.read failed for ${transcriptPath}: ${String(error)}`);
      return { action: undefined, entries: [] };
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/test/subagentTranscriptReader.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the whole gate**

Run: `npx tsc --noEmit && npm run lint && npm run test`

- [ ] **Step 6: Commit**

```bash
git add src/subagentTranscriptReader.ts src/test/subagentTranscriptReader.test.ts
git commit -m "feat: read subagent transcripts incrementally for live activity"
```

---

### Task 6: Snapshot builder

**Files:**

- Create: `src/officeSnapshot.ts`
- Test: `src/test/officeSnapshot.test.ts`

**Interfaces:**

- Consumes: `Session` from `src/types.ts`, `AgentView` from `src/officeTypes.ts`
- Produces:
  - `buildSnapshot(sessions: readonly Session[], actions: ReadonlyMap<string, string>): { agents: AgentView[]; truncated: number }`
  - `MAX_VISIBLE_AGENTS = 24`

`actions` maps agent id → current action string (built by Task 8 from Tasks 3 and 5). An id absent from the map simply has no action.

- [ ] **Step 1: Write the failing test**

```ts
// src/test/officeSnapshot.test.ts
import { describe, it, expect } from 'vitest';
import { buildSnapshot, MAX_VISIBLE_AGENTS } from '../officeSnapshot';
import type { Session, SubAgent } from '../types';

function subagent(over: Partial<SubAgent> = {}): SubAgent {
  return { id: 'sub-1', name: 'debugger', task: 'find the bug', status: 'working', ...over };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    projectHash: 'h',
    projectPath: '/p',
    projectName: 'proj',
    gitBranch: 'main',
    status: 'working',
    lastInteractionTime: 1000,
    subagents: [],
    logFilePath: '/p/sess-1.jsonl',
    type: 'claude-code',
    ...over,
  };
}

describe('buildSnapshot', () => {
  it('maps a session to a session-kind agent', () => {
    const { agents } = buildSnapshot([session({ model: 'claude-sonnet-5' })], new Map());
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: 'sess-1',
      kind: 'session',
      projectName: 'proj',
      brand: 'claude-code',
      status: 'working',
      model: 'claude-sonnet-5',
    });
    expect(agents[0].parentId).toBeUndefined();
  });

  it('uses the session title as the name when present, else the project name', () => {
    const titled = buildSnapshot([session({ sessionTitle: 'Fix the parser' })], new Map());
    expect(titled.agents[0].name).toBe('Fix the parser');
    expect(buildSnapshot([session()], new Map()).agents[0].name).toBe('proj');
  });

  it('maps subagents to subagent-kind agents parented to the session', () => {
    const { agents } = buildSnapshot([session({ subagents: [subagent()] })], new Map());
    const sub = agents.find((a) => a.kind === 'subagent');
    expect(sub).toMatchObject({ id: 'sub-1', name: 'debugger', parentId: 'sess-1', projectName: 'proj' });
  });

  it('flattens nested grandchildren one level, parented to their own launcher', () => {
    const parent = subagent({ id: 'sub-1', children: [subagent({ id: 'sub-2', name: 'explorer' })] });
    const { agents } = buildSnapshot([session({ subagents: [parent] })], new Map());
    expect(agents.find((a) => a.id === 'sub-2')?.parentId).toBe('sub-1');
  });

  it('attaches actions by agent id and leaves unknown ids without one', () => {
    const { agents } = buildSnapshot(
      [session({ subagents: [subagent()] })],
      new Map([['sess-1', 'Editing logParser.ts']]),
    );
    expect(agents.find((a) => a.id === 'sess-1')?.action).toBe('Editing logParser.ts');
    expect(agents.find((a) => a.id === 'sub-1')?.action).toBeUndefined();
  });

  it('never attaches an action to a stopped agent', () => {
    const { agents } = buildSnapshot([session({ status: 'stopped' })], new Map([['sess-1', 'Editing x.ts']]));
    expect(agents[0].action).toBeUndefined();
  });

  it('inherits the session model when a subagent has none', () => {
    const { agents } = buildSnapshot([session({ model: 'claude-opus-5', subagents: [subagent()] })], new Map());
    expect(agents.find((a) => a.id === 'sub-1')?.model).toBe('claude-opus-5');
  });

  it('orders working agents before stopped ones, then by recency', () => {
    const sessions = [
      session({ id: 'old-idle', status: 'stopped', lastInteractionTime: 10 }),
      session({ id: 'new-idle', status: 'stopped', lastInteractionTime: 90 }),
      session({ id: 'busy', status: 'working', lastInteractionTime: 20 }),
    ];
    const { agents } = buildSnapshot(sessions, new Map());
    expect(agents.map((a) => a.id)).toEqual(['busy', 'new-idle', 'old-idle']);
  });

  it(`caps the list at ${MAX_VISIBLE_AGENTS} and reports the remainder`, () => {
    const sessions = Array.from({ length: MAX_VISIBLE_AGENTS + 7 }, (_, i) =>
      session({ id: `s-${i}`, lastInteractionTime: i }),
    );
    const { agents, truncated } = buildSnapshot(sessions, new Map());
    expect(agents).toHaveLength(MAX_VISIBLE_AGENTS);
    expect(truncated).toBe(7);
  });

  it('reports zero truncated when everything fits', () => {
    expect(buildSnapshot([session()], new Map()).truncated).toBe(0);
  });

  it('returns an empty snapshot for no sessions', () => {
    expect(buildSnapshot([], new Map())).toEqual({ agents: [], truncated: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/officeSnapshot.test.ts`
Expected: FAIL — cannot resolve `../officeSnapshot`.

- [ ] **Step 3: Write the implementation**

```ts
// src/officeSnapshot.ts
// Flattens the session tree into the flat cast of characters the office renders.
// Ordering and the visible cap live here (pure) rather than in the webview, so both are
// unit-tested and deterministic — the office must never reshuffle between refreshes.

import type { AgentView } from './officeTypes';
import type { Session, SubAgent } from './types';

export const MAX_VISIBLE_AGENTS = 24;

function subagentViews(session: Session, subagent: SubAgent, parentId: string): AgentView[] {
  const self: AgentView = {
    id: subagent.id,
    kind: 'subagent',
    parentId,
    name: subagent.name,
    model: subagent.model ?? session.model,
    projectName: session.projectName,
    brand: session.type,
    status: subagent.status,
    lastActivityAt: session.lastInteractionTime,
  };
  // Grandchildren are parented to their own launcher, not to the session — nesting is
  // truncated at one level upstream, so this recursion is at most two deep.
  const children = (subagent.children ?? []).flatMap((child) => subagentViews(session, child, subagent.id));
  return [self, ...children];
}

function sessionViews(session: Session): AgentView[] {
  const self: AgentView = {
    id: session.id,
    kind: 'session',
    name: session.sessionTitle ?? session.projectName,
    model: session.model,
    projectName: session.projectName,
    brand: session.type,
    status: session.status,
    lastActivityAt: session.lastInteractionTime,
  };
  return [self, ...session.subagents.flatMap((sub) => subagentViews(session, sub, session.id))];
}

/** Working first, then most recently active — stable, so the cast never oscillates. */
function byRelevance(a: AgentView, b: AgentView): number {
  if (a.status !== b.status) {
    return a.status === 'working' ? -1 : 1;
  }
  return b.lastActivityAt - a.lastActivityAt;
}

export function buildSnapshot(
  sessions: readonly Session[],
  actions: ReadonlyMap<string, string>,
): { agents: AgentView[]; truncated: number } {
  const all = sessions
    .flatMap(sessionViews)
    .map((agent) => (agent.status === 'working' ? { ...agent, action: actions.get(agent.id) } : agent))
    .sort(byRelevance);

  return {
    agents: all.slice(0, MAX_VISIBLE_AGENTS),
    truncated: Math.max(0, all.length - MAX_VISIBLE_AGENTS),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/test/officeSnapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the whole gate**

Run: `npx tsc --noEmit && npm run lint && npm run test`

- [ ] **Step 6: Commit**

```bash
git add src/officeSnapshot.ts src/test/officeSnapshot.test.ts
git commit -m "feat: build the office cast snapshot from session state"
```

---

### Task 7: Build pipeline and lint boundaries for the webview

Do this before writing webview code, so the first webview file is linted and bundled correctly from the start.

**Files:**

- Modify: `esbuild.js`
- Modify: `eslint.config.mjs:15-21` (layer globs) and its `boundaries` element/rule config
- Modify: `vitest.config.ts` (coverage excludes)
- Modify: `.vscodeignore`
- Modify: `tsconfig.json` (DOM lib for the webview sources)
- Create: `src/webview/main.ts` (minimal placeholder so the bundle has an entry point)

**Interfaces:**

- Consumes: nothing
- Produces: `dist/webview.js` build output; lint categories `webview-sim`, `webview-render`.

- [ ] **Step 1: Install Phaser**

```bash
npm install phaser@^3.90.0
```

Phaser is a runtime dependency of the webview bundle, but esbuild inlines it, so it must be a `devDependency` — `vsce package --no-dependencies` ships only `dist/`.

```bash
npm install --save-dev phaser
```

- [ ] **Step 2: Add the second esbuild entry point**

Add `const fs = require('fs');` and `const path = require('path');` at the top of `esbuild.js` (it currently requires only `esbuild`), then replace the single `buildOptions` object with two and build both:

```js
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  minify: isMinify,
  sourcemap: !isMinify,
  logLevel: 'info',
};

// The office webview runs in a browser context inside VS Code, not in Node. Phaser is
// bundled in here — it must never reach the extension bundle.
const webviewOptions = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: isMinify,
  sourcemap: !isMinify,
  logLevel: 'info',
};

// The premium tileset is licensed per developer and never committed. When the directory
// exists locally its files win over the CC0 baseline; filenames are identical, so nothing
// downstream branches on which tier is active.
function applyPremiumAssets() {
  const premium = path.join(__dirname, 'resources', 'office-premium');
  const baseline = path.join(__dirname, 'resources', 'office');
  if (!fs.existsSync(premium)) {
    return;
  }
  for (const file of fs.readdirSync(premium)) {
    fs.copyFileSync(path.join(premium, file), path.join(baseline, file));
  }
  console.log('Applied premium office assets over the baseline.');
}

async function run() {
  applyPremiumAssets();
  if (isWatch) {
    for (const options of [extensionOptions, webviewOptions]) {
      const ctx = await esbuild.context(options);
      await ctx.watch();
    }
    console.log('Watching for changes...');
  } else {
    await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
  }
}
```

- [ ] **Step 3: Create the placeholder webview entry**

```ts
// src/webview/main.ts
// Bootstrap for the office webview. Filled in by Task 11.
export {};
```

- [ ] **Step 4: Teach ESLint about the new layers**

In `eslint.config.mjs`, add `officePanel` to `VSCODE_LAYER_MODULES` (line 15) so the panel may import `vscode`:

```js
const VSCODE_LAYER_MODULES = [
  'extension',
  'sessionTreeDataProvider',
  'treeItems',
  'subagentTreeChildren',
  'officePanel',
];
```

Then add `boundaries/elements` entries for the webview folders and a rule forbidding Phaser and DOM globals inside the simulation:

```js
// Simulation logic must stay renderable-agnostic: it is the only part of the webview
// covered by unit tests, and importing Phaser would make it untestable in vitest's
// node environment.
{
  files: ['src/webview/simulation/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', { patterns: ['phaser', 'phaser/*'] }],
    'no-restricted-globals': ['error', 'document', 'window'],
  },
},
```

- [ ] **Step 5: Keep coverage honest**

In `vitest.config.ts`, add to `coverage.exclude`:

```
'src/officePanel.ts',
'src/webview/main.ts',
'src/webview/render/**',
'src/webview/ui/**',
```

Do **not** exclude `src/webview/simulation/**` — it is unit-tested and must count.

- [ ] **Step 6: Allow DOM types for the webview sources**

In `tsconfig.json`, add `"DOM"` to `compilerOptions.lib` alongside the existing entries, so `src/webview/ui/**` compiles. Leave `types: ["node"]` untouched — it is pinned deliberately (see `.claude/memory/architecture-types-node-pin-under-nodenext.md`).

- [ ] **Step 7: Ship the new files**

`.vscodeignore` currently excludes `**/*.ts` and `src/**`, and does not exclude `dist/` or `resources/` other than screenshots — so `dist/webview.js` and `resources/office/**` already ship. Verify, do not "fix" it blindly:

```bash
npx @vscode/vsce ls | grep -E "dist/webview.js|resources/office" | head
```

Expected: both listed.

- [ ] **Step 8: Verify build and size**

```bash
npm run build && ls -la dist/
npm run lint && npx tsc --noEmit && npm run test
```

Expected: `dist/webview.js` exists; lint, typecheck and the 175 existing tests are green.

Then check the packaged size against the 2 MB release guard:

```bash
npm run package:ci && ls -la *.vsix && rm -f *.vsix
```

Expected: under 2 MB. If it is over, report it and stop — the guard is a release blocker, not something to raise silently.

- [ ] **Step 9: Commit**

```bash
git add esbuild.js eslint.config.mjs vitest.config.ts tsconfig.json package.json package-lock.json src/webview/main.ts
git commit -m "build: add browser webview bundle with Phaser and layer lint rules"
```

---

### Task 8: Office panel (extension side)

**Files:**

- Create: `src/officePanel.ts`
- Modify: `src/sessionTreeDataProvider.ts` (add `getSessions()` + `onDidChangeSessions`)
- Modify: `src/extension.ts` (register `agentville.openOffice`)
- Modify: `package.json` (contribute the command)

**Interfaces:**

- Consumes: `buildSnapshot` (Task 6), `RecentEntryStore` (Task 4), `SubagentTranscriptReader` + `subagentTranscriptPath` (Task 5), `extractAction` (Task 3), `ToWebview`/`ToExtension` (Task 2)
- Produces: `class OfficePanel` with `static show(context, provider): void`

- [ ] **Step 1: Expose session state from the provider**

In `src/sessionTreeDataProvider.ts`, add next to the existing `_onDidChangeTreeData` emitter:

```ts
  private readonly _onDidChangeSessions = new vscode.EventEmitter<void>();
  /** Fires whenever the session map is refreshed — the office subscribes to this. */
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  /** Current sessions, already deduped and ranked. The office renders from this. */
  getSessions(): Session[] {
    return [...this.sessions.values()];
  }
```

Fire `this._onDidChangeSessions.fire()` in the same place the provider already fires `_onDidChangeTreeData` after a refresh, and dispose it alongside the existing emitter in `dispose()`.

Note: the private field holding the session map may be named differently — read the file and use the real name rather than assuming `this.sessions`.

- [ ] **Step 2: Write the panel**

```ts
// src/officePanel.ts
// The office webview: a single editor-tab panel that mirrors the provider's session state
// into a 2D world. It creates no scanner, watcher or timer of its own — everything is
// driven by the provider's existing refresh cycle, so a closed office costs nothing.

import * as vscode from 'vscode';
import * as fs from 'fs';
import { buildSnapshot } from './officeSnapshot';
import { RecentEntryStore } from './recentEntries';
import { SubagentTranscriptReader, subagentTranscriptPath } from './subagentTranscriptReader';
import { logDebug } from './logger';
import type { SessionTreeDataProvider } from './sessionTreeDataProvider';
import type { ToExtension } from './officeTypes';
import type { Session } from './types';

export class OfficePanel {
  private static current: OfficePanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly entries = new RecentEntryStore();
  private readonly reader = new SubagentTranscriptReader();
  private readonly actions = new Map<string, string>();
  private openFeedAgentId: string | undefined;
  private webviewReady = false;

  static show(context: vscode.ExtensionContext, provider: SessionTreeDataProvider): void {
    if (OfficePanel.current) {
      OfficePanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel('agentville.office', 'AgentVille', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist'),
        vscode.Uri.joinPath(context.extensionUri, 'resources'),
      ],
    });
    OfficePanel.current = new OfficePanel(panel, context, provider);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly provider: SessionTreeDataProvider,
  ) {
    panel.webview.html = this.html(context.extensionUri);

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message: ToExtension) => this.onMessage(message)),
      provider.onDidChangeSessions(() => this.push()),
      panel.onDidChangeViewState(() => {
        if (panel.visible) {
          this.push();
        }
      }),
    );
  }

  private onMessage(message: ToExtension): void {
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        this.push();
        return;
      case 'openFeed':
        this.openFeedAgentId = message.agentId;
        this.pushFeed();
        return;
      case 'closeFeed':
        this.openFeedAgentId = undefined;
        return;
      case 'openLog':
        void vscode.commands.executeCommand('agentville.openSessionLog', this.itemFor(message.agentId));
        return;
      case 'openProject':
        void vscode.commands.executeCommand('agentville.openProject', this.itemFor(message.agentId));
        return;
    }
  }

  private itemFor(agentId: string): { session: Session } | undefined {
    const session = this.provider.getSessions().find((s) => s.id === agentId);
    return session ? { session } : undefined;
  }

  /** Refresh actions from live subagent transcripts, then post a full snapshot. */
  private push(): void {
    if (!this.webviewReady) {
      return;
    }
    try {
      const sessions = this.provider.getSessions();
      this.refreshActions(sessions);
      const { agents, truncated } = buildSnapshot(sessions, this.actions);
      this.entries.retain(agents.map((a) => a.id));
      void this.panel.webview.postMessage({ type: 'snapshot', agents, truncated });
      this.pushFeed();
    } catch (error) {
      logDebug(`OfficePanel.push failed: ${String(error)}`);
    }
  }

  private refreshActions(sessions: readonly Session[]): void {
    for (const session of sessions) {
      for (const subagent of session.subagents) {
        // Only working subagents: a finished one cannot produce a new action, and reading
        // every completed transcript would multiply I/O by the session's whole history.
        if (subagent.status !== 'working') {
          continue;
        }
        const agentId = subagent.agentId ?? subagent.id;
        const result = this.reader.read(subagentTranscriptPath(session.logFilePath, agentId));
        if (result.action) {
          this.actions.set(subagent.id, result.action);
        }
        for (const entry of result.entries) {
          this.entries.push(subagent.id, entry);
        }
      }
    }
  }

  private pushFeed(): void {
    const agentId = this.openFeedAgentId;
    if (!agentId) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'feed', agentId, entries: this.entries.get(agentId) });
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    const assets = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'office'));
    const nonce = Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64').slice(0, 32);
    // Phaser's WebGL renderer needs blob: for its shaders; images come from the extension
    // resource root only. No remote origin is allowed.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' blob:`,
      'connect-src blob:',
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>AgentVille</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  #office { position: relative; width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="office" data-assets="${assets.toString()}"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    OfficePanel.current = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.panel.dispose();
  }
}
```

Note: `fs` is imported above only if the final implementation needs it; remove the import if unused — `noUnusedLocals` will fail the build otherwise.

- [ ] **Step 3: Register the command**

In `src/extension.ts`, inside `registerCommands`:

```ts
const openOfficeCmd = vscode.commands.registerCommand('agentville.openOffice', () => {
  logDebug('command(): openOffice invoked');
  OfficePanel.show(context, provider);
});
context.subscriptions.push(openOfficeCmd);
```

Import `OfficePanel` at the top. `registerCommands` already receives `context` and `provider`.

- [ ] **Step 4: Contribute the command in package.json**

Add to `contributes.commands`:

```json
{
  "command": "agentville.openOffice",
  "title": "AgentVille: Open Office",
  "icon": "$(game)"
}
```

And to `contributes.menus["view/title"]`:

```json
{
  "command": "agentville.openOffice",
  "when": "view == agentville.world && config.agentville.enabled",
  "group": "navigation@2"
}
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run test && npm run build`
Expected: all clean.

Then press **F5** and run **AgentVille: Open Office** from the command palette. Expected: an editor tab opens, blank (the renderer arrives in Task 10), with no errors in the webview developer tools console.

- [ ] **Step 6: Commit**

```bash
git add src/officePanel.ts src/extension.ts src/sessionTreeDataProvider.ts package.json
git commit -m "feat: add the office webview panel and its state pump"
```

---

### Task 9: Webview simulation (pure)

**Files:**

- Create: `src/webview/simulation/world.ts`
- Create: `src/webview/simulation/population.ts`
- Create: `src/webview/simulation/movement.ts`
- Test: `src/test/officeSimulation.test.ts`

**Interfaces:**

- Consumes: `AgentView` (Task 2)
- Produces:
  - `world.ts`: `TILE_SIZE = 16`, `MAP_TILES_X = 40`, `MAP_TILES_Y = 24`, `DOOR = { x, y }`, `OFFICE_MAP: readonly string[]`, `tileAt(tx, ty): TileKind`, `isWalkable(x, y): boolean`, `walkableTiles(): {tx, ty}[]`, `byDepth(a, b): number`
  - `population.ts`: `interface Character { id; sprite; x; y; targetX; targetY; state; agent }`, `reconcile(cast: readonly Character[], agents: readonly AgentView[]): Character[]`, `spriteVariantFor(name: string): number`
  - `movement.ts`: `step(character: Character, deltaMs: number): Character`, `pickTarget(character: Character, random: () => number): Character`

- [ ] **Step 1: Write the failing test**

```ts
// src/test/officeSimulation.test.ts
import { describe, it, expect } from 'vitest';
import {
  TILE_SIZE,
  MAP_TILES_X,
  MAP_TILES_Y,
  DOOR,
  OFFICE_MAP,
  tileAt,
  isWalkable,
  walkableTiles,
  byDepth,
} from '../webview/simulation/world';
import { reconcile, spriteVariantFor, type Character } from '../webview/simulation/population';
import { step, pickTarget } from '../webview/simulation/movement';
import type { AgentView } from '../officeTypes';

function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    id: 'a1',
    kind: 'session',
    name: 'proj',
    projectName: 'proj',
    brand: 'claude-code',
    status: 'working',
    lastActivityAt: 1,
    ...over,
  };
}

describe('world', () => {
  it('is a rectangular map of the declared size', () => {
    expect(OFFICE_MAP).toHaveLength(MAP_TILES_Y);
    for (const row of OFFICE_MAP) {
      expect(row).toHaveLength(MAP_TILES_X);
    }
  });

  it('places the door on a walkable tile inside the map', () => {
    expect(isWalkable(DOOR.x, DOOR.y)).toBe(true);
    expect(DOOR.x).toBeLessThan(MAP_TILES_X * TILE_SIZE);
    expect(DOOR.y).toBeLessThan(MAP_TILES_Y * TILE_SIZE);
  });

  it('rejects points outside the map', () => {
    expect(isWalkable(-1, 10)).toBe(false);
    expect(isWalkable(10, -1)).toBe(false);
    expect(isWalkable(MAP_TILES_X * TILE_SIZE + 1, 10)).toBe(false);
  });

  it('treats furniture as solid and floor as walkable', () => {
    const desk = OFFICE_MAP.findIndex((row) => row.includes('D'));
    expect(desk).toBeGreaterThanOrEqual(0);
    const deskX = OFFICE_MAP[desk].indexOf('D');
    expect(isWalkable(deskX * TILE_SIZE + 1, desk * TILE_SIZE + 1)).toBe(false);
    expect(tileAt(0, 0)).toBe('#');
    expect(isWalkable(1, 1)).toBe(false);
  });

  it('exposes every walkable tile, and only walkable ones', () => {
    const tiles = walkableTiles();
    expect(tiles.length).toBeGreaterThan(100);
    for (const tile of tiles) {
      expect(isWalkable(tile.x, tile.y)).toBe(true);
    }
  });

  it('sorts by Y so lower characters draw in front', () => {
    expect(byDepth({ y: 10 }, { y: 20 })).toBeLessThan(0);
    expect(byDepth({ y: 30 }, { y: 20 })).toBeGreaterThan(0);
  });
});

describe('spriteVariantFor', () => {
  it('is stable for the same name', () => {
    expect(spriteVariantFor('debugger')).toBe(spriteVariantFor('debugger'));
  });

  it('spreads different names across variants', () => {
    const variants = new Set(['debugger', 'explorer-agent', 'test-engineer', 'code-reviewer'].map(spriteVariantFor));
    expect(variants.size).toBeGreaterThan(1);
  });
});

describe('reconcile', () => {
  it('spawns a character at the door for a new agent', () => {
    const [character] = reconcile([], [agent()]);
    expect(character.id).toBe('a1');
    expect(character.x).toBe(DOOR.x);
    expect(character.y).toBe(DOOR.y);
    expect(character.state).toBe('entering');
  });

  it('keeps position and state for an agent that is still present', () => {
    const existing: Character = { ...reconcile([], [agent()])[0], x: 100, y: 50, state: 'walking' };
    const [next] = reconcile([existing], [agent({ action: 'Editing x.ts' })]);
    expect(next.x).toBe(100);
    expect(next.y).toBe(50);
    expect(next.state).toBe('walking');
    expect(next.agent.action).toBe('Editing x.ts');
  });

  it('marks a character leaving when its agent disappears', () => {
    const existing = reconcile([], [agent()])[0];
    const [next] = reconcile([existing], []);
    expect(next.state).toBe('leaving');
    expect(next.targetX).toBe(DOOR.x);
  });

  it('removes a leaving character once it reaches the door', () => {
    const leaving: Character = { ...reconcile([], [agent()])[0], state: 'leaving', x: DOOR.x, y: DOOR.y };
    expect(reconcile([leaving], [])).toHaveLength(0);
  });

  it('does not mutate the cast it is given', () => {
    const cast = reconcile([], [agent()]);
    const snapshot = JSON.stringify(cast);
    reconcile(cast, []);
    expect(JSON.stringify(cast)).toBe(snapshot);
  });
});

describe('movement', () => {
  it('moves a character toward its target', () => {
    const base = reconcile([], [agent()])[0];
    const character: Character = { ...base, x: 0, y: 0, targetX: 100, targetY: 0 };
    expect(step(character, 100).x).toBeGreaterThan(0);
  });

  it('never overshoots the target', () => {
    const base = reconcile([], [agent()])[0];
    const character: Character = { ...base, x: 99, y: 0, targetX: 100, targetY: 0 };
    expect(step(character, 5000).x).toBe(100);
  });

  it('picks a walkable target, never inside furniture', () => {
    const base = reconcile([], [agent()])[0];
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const picked = pickTarget(base, () => r);
      expect(isWalkable(picked.targetX, picked.targetY)).toBe(true);
      expect(picked.state).toBe('walking');
    }
  });

  it('is deterministic for a given random source', () => {
    const base = reconcile([], [agent()])[0];
    expect(pickTarget(base, () => 0.5)).toEqual(pickTarget(base, () => 0.5));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/officeSimulation.test.ts`
Expected: FAIL — cannot resolve the simulation modules.

- [ ] **Step 3: Write `world.ts`**

```ts
// src/webview/simulation/world.ts
// Map geometry AND layout. Pure data and predicates — no Phaser, no DOM (enforced by
// ESLint), so the whole office plan is unit-testable.
//
// The office is authored as ASCII art: 24 rows of 40 characters, one per tile. This is
// deliberate — a furnished, zoned map is what makes the space read as an office rather
// than a floor with people on it (the reference experience is Gather), and a designer can
// rearrange the whole floor here without touching a line of rendering code.

export const TILE_SIZE = 16;
export const MAP_TILES_X = 40;
export const MAP_TILES_Y = 24;

export const WORLD_WIDTH = MAP_TILES_X * TILE_SIZE;
export const WORLD_HEIGHT = MAP_TILES_Y * TILE_SIZE;

// # wall   . floor   , rug   D desk   C chair   T meeting table
// P plant  S sofa    K coffee counter  R printer/shelf   _ door
export const OFFICE_MAP: readonly string[] = [
  '########################################',
  '#..........#..........#................#',
  '#.DDDD.DDDD#.DDDD.DDDD#...TTTTTTTT.....#',
  '#.CCCC.CCCC#.CCCC.CCCC#...C......C.....#',
  '#......................#..C......C.....#',
  '#.DDDD.DDDD#.DDDD.DDDD#...TTTTTTTT.....#',
  '#.CCCC.CCCC#.CCCC.CCCC#...............P#',
  '#..........#..........#................#',
  '#......................................#',
  '#.P..................................P.#',
  '#......................................#',
  '#####.############.#####################',
  '#..........,,,,,,,.....................#',
  '#.KKKK.....,,,,,,,.................RRRR#',
  '#..........,,,,,,,.....................#',
  '#.SSSS.....,,,,,,,.....................#',
  '#..........,,,,,,,.................RRRR#',
  '#......................................#',
  '#.P..................................P.#',
  '#......................................#',
  '#......................................#',
  '#......................................#',
  '#..................__..................#',
  '########################################',
];

const WALKABLE = new Set(['.', ',', '_']);

export type TileKind = string;

export function tileAt(tx: number, ty: number): TileKind {
  return OFFICE_MAP[ty]?.[tx] ?? '#';
}

/** World-pixel coordinates → can a character stand here? Furniture is solid. */
export function isWalkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= WORLD_WIDTH || y >= WORLD_HEIGHT) {
    return false;
  }
  return WALKABLE.has(tileAt(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE)));
}

/** Every standable tile, as world-pixel centres. Computed once — the map never changes. */
const WALKABLE_TILES: { x: number; y: number }[] = OFFICE_MAP.flatMap((row, ty) =>
  [...row].flatMap((tile, tx) =>
    WALKABLE.has(tile) ? [{ x: tx * TILE_SIZE + TILE_SIZE / 2, y: ty * TILE_SIZE + TILE_SIZE / 2 }] : [],
  ),
);

export function walkableTiles(): readonly { x: number; y: number }[] {
  return WALKABLE_TILES;
}

/** Where characters enter and leave — the '_' door tiles on the bottom wall. */
const DOOR_TILE_X = OFFICE_MAP[MAP_TILES_Y - 2].indexOf('_');
export const DOOR = {
  x: DOOR_TILE_X * TILE_SIZE + TILE_SIZE / 2,
  y: (MAP_TILES_Y - 2) * TILE_SIZE + TILE_SIZE / 2,
} as const;

/** Lower on screen draws in front. */
export function byDepth(a: { y: number }, b: { y: number }): number {
  return a.y - b.y;
}
```

- [ ] **Step 4: Write `population.ts`**

```ts
// src/webview/simulation/population.ts
// Reconciles a snapshot against the current cast. Pure: takes the old cast plus the new
// agent list, returns a brand-new cast. Never mutates its input — the renderer holds a
// reference to the previous array while this runs.

import type { AgentView } from '../../officeTypes';
import { DOOR } from './world';

export const SPRITE_VARIANTS = 4;

export type CharacterState = 'entering' | 'walking' | 'idle' | 'leaving';

export interface Character {
  id: string;
  sprite: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  state: CharacterState;
  agent: AgentView;
}

/** Stable per-name sprite choice, so the same agent is always the same person. */
export function spriteVariantFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % SPRITE_VARIANTS;
}

function spawn(agent: AgentView): Character {
  return {
    id: agent.id,
    sprite: spriteVariantFor(agent.name),
    x: DOOR.x,
    y: DOOR.y,
    targetX: DOOR.x,
    targetY: DOOR.y,
    state: 'entering',
    agent,
  };
}

const AT_DOOR_EPSILON = 1;

function hasReachedDoor(character: Character): boolean {
  return Math.abs(character.x - DOOR.x) <= AT_DOOR_EPSILON && Math.abs(character.y - DOOR.y) <= AT_DOOR_EPSILON;
}

export function reconcile(cast: readonly Character[], agents: readonly AgentView[]): Character[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const seen = new Set<string>();

  const kept: Character[] = [];
  for (const character of cast) {
    const agent = byId.get(character.id);
    if (agent) {
      seen.add(character.id);
      kept.push({ ...character, agent });
      continue;
    }
    if (character.state === 'leaving' && hasReachedDoor(character)) {
      continue; // walked out — drop it
    }
    kept.push({ ...character, state: 'leaving', targetX: DOOR.x, targetY: DOOR.y });
  }

  const spawned = agents.filter((agent) => !seen.has(agent.id)).map(spawn);
  return [...kept, ...spawned];
}
```

- [ ] **Step 5: Write `movement.ts`**

```ts
// src/webview/simulation/movement.ts
// Position stepping and target selection. Movement is meaningless in this sub-project —
// characters wander. Sub-project 2 replaces `pickTarget` with furniture-aware selection;
// nothing else needs to change, which is why target choice is isolated here.

import type { Character } from './population';
import { walkableTiles } from './world';

const SPEED_PX_PER_MS = 0.02;

export function step(character: Character, deltaMs: number): Character {
  const dx = character.targetX - character.x;
  const dy = character.targetY - character.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return character;
  }
  const travel = Math.min(distance, SPEED_PX_PER_MS * deltaMs);
  return {
    ...character,
    x: character.x + (dx / distance) * travel,
    y: character.y + (dy / distance) * travel,
  };
}

/** Choose a new wander destination. `random` is injected so tests stay deterministic. */
export function pickTarget(character: Character, random: () => number): Character {
  // Draw from the walkable set rather than guessing coordinates: the map is furnished, so
  // most of the grid is solid and rejection sampling would stall against desks.
  const tiles = walkableTiles();
  if (tiles.length === 0) {
    return { ...character, state: 'idle' };
  }
  const tile = tiles[Math.min(tiles.length - 1, Math.floor(random() * tiles.length))];
  return { ...character, targetX: tile.x, targetY: tile.y, state: 'walking' };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/test/officeSimulation.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify the whole gate**

Run: `npx tsc --noEmit && npm run lint && npm run test`
Expected: clean. In particular, the `no-restricted-imports` rule from Task 7 must not fire — the simulation imports nothing from Phaser.

- [ ] **Step 8: Commit**

```bash
git add src/webview/simulation src/test/officeSimulation.test.ts
git commit -m "feat: add pure office simulation — population, movement, world"
```

---

### Task 10: Phaser renderer

**Files:**

- Create: `src/webview/render/officeScene.ts`

**Interfaces:**

- Consumes: `Character` and `reconcile` (Task 9), `step`/`pickTarget` (Task 9), `world` constants (Task 9), the sprite sheet layout from `resources/ASSETS.md` (Task 1)
- Produces:
  - `class OfficeScene extends Phaser.Scene`
  - `setAgents(agents: readonly AgentView[]): void`
  - `onCharacterPositions(callback: (positions: { id: string; screenX: number; screenY: number; action?: string }[]) => void): void`
  - `createOffice(parent: HTMLElement, assetsBaseUri: string): OfficeScene`

- [ ] **Step 1: Write the scene**

```ts
// src/webview/render/officeScene.ts
// Phaser draws; it does not decide. Every position and state transition comes from
// `simulation/`, which is unit-tested without a browser. This file owns only textures,
// sprites, animations and the frame loop.

import Phaser from 'phaser';
import type { AgentView } from '../../officeTypes';
import { reconcile, type Character } from '../simulation/population';
import { pickTarget, step } from '../simulation/movement';
import {
  DOOR,
  MAP_TILES_X,
  MAP_TILES_Y,
  TILE_SIZE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  byDepth,
  tileAt,
} from '../simulation/world';

const IDLE_PAUSE_MS = 1200;
const CHARACTER_FRAME = { frameWidth: 16, frameHeight: 24 };

/**
 * Map character → frame index in tiles.png. The indices below are placeholders: replace
 * them with the real ones for the pack chosen in Task 1 and recorded in
 * resources/ASSETS.md. Both asset tiers share one layout, so this table is written once.
 */
const TILE_FRAMES: Record<string, number> = {
  '.': 0, // floor
  '#': 1, // wall
  ',': 2, // rug
  D: 3, // desk
  C: 4, // chair
  T: 5, // meeting table
  P: 6, // plant
  S: 7, // sofa
  K: 8, // coffee counter
  R: 9, // shelf / printer
  _: 10, // door
};

export interface RenderedPosition {
  id: string;
  name: string;
  screenX: number;
  screenY: number;
  action?: string;
}

export class OfficeScene extends Phaser.Scene {
  private cast: Character[] = [];
  private pending: AgentView[] = [];
  private readonly sprites = new Map<string, Phaser.GameObjects.Sprite>();
  private readonly pauseUntil = new Map<string, number>();
  private positionListener?: (positions: RenderedPosition[]) => void;

  constructor(private readonly assetsBaseUri: string) {
    super('office');
  }

  preload(): void {
    this.load.image('tiles', `${this.assetsBaseUri}/tiles.png`);
    this.load.spritesheet('characters', `${this.assetsBaseUri}/characters.png`, CHARACTER_FRAME);
  }

  create(): void {
    this.drawMap();
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.anims.create({
      key: 'walk',
      frames: this.anims.generateFrameNumbers('characters', { start: 0, end: 3 }),
      frameRate: 6,
      repeat: -1,
    });
  }

  /**
   * Paints the authored office once, tile by tile. Static: the map never changes at
   * runtime, so this runs in create() and is never touched again — only characters move.
   * TILE_FRAMES maps each map character to a frame index in tiles.png; fill in the real
   * indices from the layout recorded in resources/ASSETS.md.
   */
  private drawMap(): void {
    for (let ty = 0; ty < MAP_TILES_Y; ty++) {
      for (let tx = 0; tx < MAP_TILES_X; tx++) {
        const kind = tileAt(tx, ty);
        const x = tx * TILE_SIZE;
        const y = ty * TILE_SIZE;
        // Floor goes down everywhere first, so furniture sits on a continuous floor
        // instead of a hole.
        this.add.image(x, y, 'tiles', TILE_FRAMES['.']).setOrigin(0, 0);
        const frame = TILE_FRAMES[kind];
        if (kind !== '.' && frame !== undefined) {
          // Furniture is drawn below every character (depth 0 < any character's y).
          this.add.image(x, y, 'tiles', frame).setOrigin(0, 0).setDepth(0);
        }
      }
    }
  }

  setAgents(agents: readonly AgentView[]): void {
    this.pending = [...agents];
  }

  onCharacterPositions(callback: (positions: RenderedPosition[]) => void): void {
    this.positionListener = callback;
  }

  update(time: number, delta: number): void {
    if (this.pending.length > 0 || this.cast.length > 0) {
      this.cast = reconcile(this.cast, this.pending);
    }
    this.cast = this.cast.map((character) => this.advance(character, time, delta));
    this.syncSprites();
    this.emitPositions();
  }

  private advance(character: Character, time: number, delta: number): Character {
    const moved = step(character, delta);
    const arrived = moved.x === moved.targetX && moved.y === moved.targetY;
    if (!arrived) {
      return moved;
    }
    if (moved.state === 'leaving') {
      return moved;
    }
    const pausedUntil = this.pauseUntil.get(moved.id) ?? 0;
    if (time < pausedUntil) {
      return { ...moved, state: 'idle' };
    }
    this.pauseUntil.set(moved.id, time + IDLE_PAUSE_MS);
    return pickTarget(moved, () => Math.random());
  }

  private syncSprites(): void {
    const alive = new Set(this.cast.map((c) => c.id));
    for (const [id, sprite] of this.sprites) {
      if (!alive.has(id)) {
        sprite.destroy();
        this.sprites.delete(id);
        this.pauseUntil.delete(id);
      }
    }
    for (const character of [...this.cast].sort(byDepth)) {
      let sprite = this.sprites.get(character.id);
      if (!sprite) {
        sprite = this.add.sprite(DOOR.x, DOOR.y, 'characters', character.sprite * 4);
        sprite.play('walk');
        this.sprites.set(character.id, sprite);
      }
      sprite.setPosition(character.x, character.y);
      sprite.setDepth(character.y);
      // A subagent is drawn slightly smaller than the session that launched it.
      sprite.setScale(character.agent.kind === 'subagent' ? 0.85 : 1);
      sprite.setAlpha(character.agent.status === 'working' ? 1 : 0.55);
    }
  }

  private emitPositions(): void {
    if (!this.positionListener) {
      return;
    }
    const camera = this.cameras.main;
    this.positionListener(
      this.cast.map((character) => ({
        id: character.id,
        name: character.agent.name,
        screenX: (character.x - camera.scrollX) * camera.zoom,
        screenY: (character.y - camera.scrollY - TILE_SIZE) * camera.zoom,
        action: character.agent.status === 'working' ? character.agent.action : undefined,
      })),
    );
  }
}

export function createOffice(parent: HTMLElement, assetsBaseUri: string): OfficeScene {
  const scene = new OfficeScene(assetsBaseUri);
  new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    pixelArt: true,
    backgroundColor: '#1e1e1e',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene,
  });
  return scene;
}
```

- [ ] **Step 2: Verify it builds**

Run: `npm run build && npx tsc --noEmit && npm run lint`
Expected: clean; `dist/webview.js` grows to roughly 1.2 MB.

- [ ] **Step 3: Commit**

```bash
git add src/webview/render
git commit -m "feat: render the office with Phaser from the pure simulation"
```

---

### Task 11: Bubbles, side panel and bootstrap

**Files:**

- Create: `src/webview/ui/nameTags.ts`
- Create: `src/webview/ui/bubbles.ts`
- Create: `src/webview/ui/feedPanel.ts`
- Modify: `src/webview/main.ts`
- Modify: `src/officePanel.ts` (overlay styles)

**Interfaces:**

- Consumes: `RenderedPosition` and `createOffice` (Task 10), `AgentView`/`FeedEntry`/`ToWebview`/`ToExtension` (Task 2)
- Produces: nothing consumed by later tasks — this is the top of the stack.

- [ ] **Step 1: Write the name-tag layer**

Name tags and bubbles answer different questions — the tag says _who_, the bubble says _what_ — so they are separate layers. Every character gets a tag, working or idle; only working characters get a bubble.

```ts
// src/webview/ui/nameTags.ts
// A small label under every character. Always visible, unlike the action bubble: an idle
// agent still needs to be identifiable.

import type { RenderedPosition } from '../render/officeScene';

const MAX_NAME_CHARS = 18;
const TAG_OFFSET_PX = 34;

export class NameTagLayer {
  private readonly nodes = new Map<string, HTMLDivElement>();

  constructor(private readonly root: HTMLElement) {}

  render(positions: readonly RenderedPosition[]): void {
    const alive = new Set(positions.map((p) => p.id));
    for (const [id, node] of this.nodes) {
      if (!alive.has(id)) {
        node.remove();
        this.nodes.delete(id);
      }
    }
    for (const position of positions) {
      let node = this.nodes.get(position.id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'name-tag';
        this.root.appendChild(node);
        this.nodes.set(position.id, node);
      }
      const text = position.name.length > MAX_NAME_CHARS ? `${position.name.slice(0, MAX_NAME_CHARS)}…` : position.name;
      if (node.textContent !== text) {
        node.textContent = text;
      }
      node.style.transform = `translate(${position.screenX}px, ${position.screenY + TAG_OFFSET_PX}px) translateX(-50%)`;
    }
  }
}
```

- [ ] **Step 2: Write the bubble layer**

```ts
// src/webview/ui/bubbles.ts
// Speech bubbles are DOM, not canvas text: they inherit the VS Code theme, the text can be
// selected, and click handling is native. They are absolutely positioned over the canvas
// and repositioned every frame from the renderer's reported screen coordinates.

import type { RenderedPosition } from '../render/officeScene';

const MAX_BUBBLE_CHARS = 40;

export class BubbleLayer {
  private readonly nodes = new Map<string, HTMLButtonElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly onClick: (agentId: string) => void,
  ) {}

  render(positions: readonly RenderedPosition[]): void {
    const alive = new Set(positions.filter((p) => p.action).map((p) => p.id));
    for (const [id, node] of this.nodes) {
      if (!alive.has(id)) {
        node.remove();
        this.nodes.delete(id);
      }
    }
    for (const position of positions) {
      if (!position.action) {
        continue;
      }
      let node = this.nodes.get(position.id);
      if (!node) {
        node = document.createElement('button');
        node.className = 'bubble';
        node.addEventListener('click', () => this.onClick(position.id));
        this.root.appendChild(node);
        this.nodes.set(position.id, node);
      }
      const text =
        position.action.length > MAX_BUBBLE_CHARS ? `${position.action.slice(0, MAX_BUBBLE_CHARS)}…` : position.action;
      if (node.textContent !== text) {
        node.textContent = text;
      }
      node.style.transform = `translate(${position.screenX}px, ${position.screenY}px) translateX(-50%)`;
    }
  }
}
```

- [ ] **Step 3: Write the feed panel**

```ts
// src/webview/ui/feedPanel.ts
// Side panel showing one agent's recent activity. Content arrives as a bounded window from
// the extension; this file only renders it.

import type { FeedEntry } from '../../officeTypes';

export class FeedPanel {
  private readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly title: HTMLElement;
  private agentId: string | undefined;

  constructor(
    root: HTMLElement,
    private readonly onClose: () => void,
  ) {
    this.element = document.createElement('aside');
    this.element.className = 'feed hidden';
    this.title = document.createElement('h2');
    this.list = document.createElement('div');
    this.list.className = 'feed-list';

    const close = document.createElement('button');
    close.textContent = 'Close';
    close.addEventListener('click', () => this.close());

    this.element.append(this.title, close, this.list);
    root.appendChild(this.element);
  }

  open(agentId: string, name: string): void {
    this.agentId = agentId;
    this.title.textContent = name;
    this.list.textContent = '';
    this.element.classList.remove('hidden');
  }

  close(): void {
    this.agentId = undefined;
    this.element.classList.add('hidden');
    this.onClose();
  }

  get openAgentId(): string | undefined {
    return this.agentId;
  }

  render(agentId: string, entries: readonly FeedEntry[]): void {
    if (agentId !== this.agentId) {
      return;
    }
    this.list.textContent = '';
    for (const entry of entries) {
      const item = document.createElement('article');
      item.className = `feed-entry feed-entry--${entry.role}`;
      const meta = document.createElement('span');
      meta.className = 'feed-meta';
      meta.textContent = entry.tool ?? entry.role;
      const body = document.createElement('pre');
      body.textContent = entry.text;
      item.append(meta, body);
      this.list.appendChild(item);
    }
    this.list.scrollTop = this.list.scrollHeight;
  }
}
```

- [ ] **Step 4: Write the bootstrap**

```ts
// src/webview/main.ts
// Wires the three layers together: messages from the extension feed the renderer, the
// renderer reports screen positions to the bubbles, and bubble clicks ask the extension
// for that agent's feed.

import { createOffice } from './render/officeScene';
import { BubbleLayer } from './ui/bubbles';
import { NameTagLayer } from './ui/nameTags';
import { FeedPanel } from './ui/feedPanel';
import type { AgentView, ToExtension, ToWebview } from '../officeTypes';

declare function acquireVsCodeApi(): { postMessage(message: ToExtension): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('office');
if (!root) {
  throw new Error('office root element missing');
}

const assetsBaseUri = root.dataset.assets ?? '';
let agents: AgentView[] = [];

const feed = new FeedPanel(root, () => vscode.postMessage({ type: 'closeFeed' }));
const bubbles = new BubbleLayer(root, (agentId) => {
  const agent = agents.find((a) => a.id === agentId);
  feed.open(agentId, agent?.name ?? agentId);
  vscode.postMessage({ type: 'openFeed', agentId });
});

const nameTags = new NameTagLayer(root);

const scene = createOffice(root, assetsBaseUri);
scene.onCharacterPositions((positions) => {
  nameTags.render(positions);
  bubbles.render(positions);
});

const overflow = document.createElement('div');
overflow.className = 'overflow hidden';
root.appendChild(overflow);

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'snapshot':
      agents = message.agents;
      scene.setAgents(message.agents);
      overflow.textContent = message.truncated > 0 ? `+${message.truncated} waiting` : '';
      overflow.classList.toggle('hidden', message.truncated === 0);
      return;
    case 'feed':
      feed.render(message.agentId, message.entries);
      return;
    case 'monitoringDisabled':
      scene.setAgents([]);
      overflow.textContent = 'Monitoring is disabled.';
      overflow.classList.remove('hidden');
      return;
  }
});

vscode.postMessage({ type: 'ready' });
```

- [ ] **Step 5: Add the overlay styles**

In `src/officePanel.ts`'s `html()`, extend the `<style>` block:

```css
.bubble {
  position: absolute;
  top: 0;
  left: 0;
  max-width: 220px;
  padding: 2px 8px;
  font: 11px var(--vscode-font-family);
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 10px;
  cursor: pointer;
  white-space: nowrap;
}
.name-tag {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  padding: 0 4px;
  border-radius: 4px;
  font: 10px var(--vscode-font-family);
  color: var(--vscode-editor-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 78%, transparent);
  white-space: nowrap;
}
.feed {
  position: absolute;
  top: 0;
  right: 0;
  width: 380px;
  height: 100%;
  overflow-y: auto;
  padding: 12px;
  background: var(--vscode-sideBar-background);
  border-left: 1px solid var(--vscode-editorWidget-border);
  color: var(--vscode-editor-foreground);
  font: 12px var(--vscode-font-family);
}
.feed-list pre {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 4px 0 12px;
}
.feed-meta {
  opacity: 0.65;
  font-size: 10px;
  text-transform: uppercase;
}
.overflow {
  position: absolute;
  left: 8px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font: 11px var(--vscode-font-family);
}
.hidden {
  display: none;
}
```

- [ ] **Step 6: Verify end to end**

Run: `npm run build && npx tsc --noEmit && npm run lint && npm run test`

Then press **F5**, open **AgentVille: Open Office**, and with at least one Claude Code session running confirm: characters appear and walk, bubbles show actions, clicking a bubble opens the side panel with entries, closing the tab stops everything.

- [ ] **Step 6: Commit**

```bash
git add src/webview package.json
git commit -m "feat: add action bubbles, activity side panel and webview bootstrap"
```

---

### Task 12: Real-log validation

Fixtures have already hidden a parser bug in this project once, with 153 tests green. This task is an acceptance gate, not a formality.

**Files:**

- Create: `src/test/activityExtractor.realLogs.test.ts`
- Modify: `README.md` (move the office out of Roadmap into Features)

**Interfaces:**

- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Write a real-log test following the existing pattern**

Read `src/test/logParser.realLogs.test.ts` first and match how it locates and skips real logs — it already handles "these files may not exist on this machine" without failing CI. Mirror that structure:

```ts
// src/test/activityExtractor.realLogs.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractAction } from '../activityExtractor';

const projectsDir = path.join(os.homedir(), '.claude', 'projects');

function someTranscripts(limit: number): string[] {
  if (!fs.existsSync(projectsDir)) {
    return [];
  }
  const found: string[] = [];
  for (const dir of fs.readdirSync(projectsDir)) {
    const full = path.join(projectsDir, dir);
    if (!fs.statSync(full).isDirectory()) {
      continue;
    }
    for (const file of fs.readdirSync(full)) {
      if (file.endsWith('.jsonl')) {
        found.push(path.join(full, file));
      }
      if (found.length >= limit) {
        return found;
      }
    }
  }
  return found;
}

describe('extractAction against real transcripts', () => {
  const transcripts = someTranscripts(5);

  it.skipIf(transcripts.length === 0)('never throws and never leaks a raw tool id', () => {
    let rendered = 0;
    for (const transcript of transcripts) {
      for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
        if (!line.trim()) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const action = expect(() => extractAction(parsed)).not.toThrow();
        void action;
        const result = extractAction(parsed);
        if (result) {
          rendered++;
          expect(result).not.toMatch(/^tool_use/);
          expect(result.length).toBeLessThan(80);
        }
      }
    }
    expect(rendered).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/test/activityExtractor.realLogs.test.ts`
Expected: PASS (or skipped on a machine with no `~/.claude/projects`).

- [ ] **Step 3: Validate by eye against a live session**

With Claude Code actively working in another window, open the office and compare each bubble against what that agent is genuinely doing. Confirm specifically:

- a session running a `Bash` command shows `Running …`
- a live subagent shows its own action, not its parent's
- a finished subagent has no bubble
- the `+N waiting` chip appears when more than 24 agents exist

Any mismatch is a real bug — fix it and add the failing case as a unit test in `activityExtractor.test.ts` before continuing.

- [ ] **Step 4: Update the README**

Move the office bullet points out of `## Roadmap` into `## Features`, describing what now exists. Leave sub-projects 2 and 3 (situated behaviour, progression) in the Roadmap.

- [ ] **Step 5: Final gate**

Run: `npx tsc --noEmit && npm run lint && npm run test && npm run build`
Expected: all green.

```bash
npm run package:ci && ls -la *.vsix && rm -f *.vsix
```

Expected: under 2 MB.

- [ ] **Step 6: Commit**

```bash
git add src/test/activityExtractor.realLogs.test.ts README.md
git commit -m "test: validate the action extractor against real transcripts"
```

---

## Self-Review

**Spec coverage**

| Spec section                           | Task              |
| -------------------------------------- | ----------------- |
| §4 provider change, build, command     | 7, 8              |
| §5.1 current action                    | 3                 |
| §5.2 subagent transcripts              | 5                 |
| §5.3 ring buffer                       | 4                 |
| §6 protocol                            | 2, 8, 11          |
| §7 world, identity, bubbles, capacity  | 6, 9, 10, 11      |
| §8 assets                              | 1                 |
| §9 errors, disposal, pause-when-hidden | 5, 8              |
| §10 testing incl. real logs            | 3, 4, 5, 6, 9, 12 |
| §12 acceptance criteria                | 12                |

**Known deviations from the spec, deliberate:**

- The spec put extension modules under `src/office/`. The plan keeps them flat in `src/`, because the project's `boundaries` core glob only matches direct children of `src/` — a subfolder would silently escape the `vscode`-free policy. Webview code does live in `src/webview/`, with explicit lint rules added in Task 7 to cover it.
- §9's "render pauses when hidden" is delivered by `retainContextWhenHidden: false` (Task 8), which tears the webview down when the tab is backgrounded, rather than by pausing the Phaser loop. Same observable outcome, less code.
- The spec describes the furnished map as "a tile grid plus a list of placed objects". The plan authors it as ASCII art in `world.ts` — one row of 40 characters per tile row. Same data, but editable by hand and diffable in review, and it keeps the map inside the unit-tested pure layer instead of an asset file.

**Blocked vs. unblocked at plan time:**

- **Task 1 is partly blocked.** It needs either a suitable CC0 baseline pack found and vetted, or the commercial pack purchased and dropped into the gitignored `resources/office-premium/`. Rendering (Tasks 10–11) cannot be verified without it.
- **Tasks 2–6 are fully unblocked** — pure TypeScript, TDD, no assets involved. They are the highest-risk part of the sub-project (transcript extraction) and should run first regardless of how the asset question resolves.
- **Tasks 7–9 need only Phaser installed**, not the final art: the build, the lint boundaries and the pure simulation can all be completed and tested against placeholder frames.
