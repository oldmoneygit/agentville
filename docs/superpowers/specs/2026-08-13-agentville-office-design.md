# AgentVille — The Office (sub-project 1)

**Status:** approved design, not implemented
**Date:** 2026-08-13
**Scope:** sub-project 1 of 3. Sub-projects 2 (situated behaviour) and 3 (progression)
get their own specs once this one ships.

## 1. Goal

Turn AgentVille from a tree view into a living 2D pixel office. A webview opened in an
editor tab renders an open-floor office where every running Claude Code / Antigravity
session and subagent is a character. A speech bubble follows each character showing what
it is doing right now; clicking the bubble opens a side panel with that agent's most
recent activity, updating live.

The tree view stays. The office is an additional surface, not a replacement — a user who
never opens the office pays nothing for it.

## 2. Decisions

Each decision below was taken during brainstorming and is settled. Re-opening one is a
spec change, not an implementation detail.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Open floor, no rooms.** Every session and subagent is a character on one shared floor; the project is a badge/colour, not a wall. | Chosen over per-project rooms for liveliness and simpler layout. |
| D2 | **Editor-tab webview; tree view preserved.** A command opens the office in an editor tab. | An open floor needs width a 300px sidebar cannot give. Preserving the tree means zero regression and zero cost when the office is closed. |
| D3 | **Side panel shows a live sliding window of the last ~20 entries**, not the full transcript. | Matches the existing incremental parser, bounds memory, and answers the real question ("what is it doing now"). Full history is already served by *Open Log File*. |
| D4 | **Sprites come from a permissively-licensed (CC0) pack.** | The repository is public under Apache-2.0; assets must be redistributable. See §8 for the selection gate. |
| D5 | **Phaser 3 renders; simulation logic lives outside Phaser.** | Phaser is the most mature 2D engine and makes sub-projects 2–3 much cheaper. Keeping simulation in pure TypeScript preserves the project's convention that logic is unit-testable without a DOM. |
| D6 | **Full game layer is the destination**, delivered across three sub-projects. | Explicit product choice. This spec covers only sub-project 1. |

## 3. Scope

**In scope**

- Webview panel in an editor tab, with lifecycle, CSP and asset URI handling.
- Extension→webview state protocol (§6).
- New parsing: current action per agent, and a bounded recent-activity buffer (§5).
- Parsing subagent transcripts (`<session-id>/subagents/agent-<id>.jsonl`), which the
  extension does not read today.
- Open-floor map, characters entering and leaving, idle wandering, depth sorting.
- Speech bubbles (DOM), click to open a side panel with the live feed.
- Selecting and integrating the CC0 asset pack.

**Out of scope (later sub-projects)**

- Furniture-driven movement, per-tool destinations, coffee-machine idling → sub-project 2.
- XP, levels, achievements, ranking, day/night, unlockable decoration, any persisted
  state in `globalState` → sub-project 3.
- Camera panning/zoom, scrollable maps larger than one screen.
- Replacing or removing the tree view.
- Redesigning `resources/icon.png` / `screenshot.png` (art task, tracked separately).

## 4. Architecture

```
┌─ EXTENSION (Node, may import vscode) ───────────────────────┐
│  sessionTreeDataProvider   existing: session Map, watchers,  │
│      │                     15s timer, lsof, dedupe           │
│      │  + getSessions(): Session[]                           │
│      │  + onDidChangeSessions: Event<void>                   │
│      ├──────────────► treeItems.ts        (unchanged)        │
│      └──────────────► office/officePanel.ts   [vscode]       │
│                                                              │
│  office/activityExtractor.ts   [pure, vitest]                │
│  office/recentEntries.ts       [pure, vitest]                │
│  office/officeSnapshot.ts      [pure, vitest]                │
│  subagentTranscriptReader.ts   [pure, vitest]                │
└────────────────────────────┬─────────────────────────────────┘
                             │ postMessage (JSON)
┌────────────────────────────▼─ WEBVIEW (browser) ────────────┐
│  webview/simulation/**   [pure TS, vitest]                   │
│      population, positions, movement targets, spawn/despawn  │
│  webview/render/**       [Phaser 3]  draws the simulation    │
│  webview/ui/**           [DOM]  bubbles + side panel         │
└──────────────────────────────────────────────────────────────┘
```

**Boundary rules**

- The webview bundle must not import `vscode`; the extension bundle must not import Phaser.
- `webview/simulation/**` must not import Phaser or touch the DOM. It is plain functions
  over plain data, unit-tested in vitest exactly like the existing parsing core.
- `webview/render/**` reads simulation output and never mutates it.
- Existing ESLint `boundaries` rules are extended to enforce the three lines above.

**Provider change.** `SessionTreeDataProvider` gains exactly two public members —
`getSessions()` and `onDidChangeSessions` — so the office subscribes to the same state the
tree uses. No second scanner, watcher or timer is created. If the provider later grows
past a comfortable size, extracting a `SessionStore` is the follow-up; this spec does not
do it, because two members is a smaller change than a refactor.

**Build.** `esbuild.js` currently emits one Node bundle. It gains a second entry point for
the webview (`platform: 'browser'`, IIFE, Phaser bundled), emitted to `dist/webview.js`.
Sprite and tile assets live in `resources/office/`. `.vscodeignore` must keep shipping
`dist/**` and `resources/office/**`.

**Command.** The office is opened by `agentville.openOffice` ("AgentVille: Open Office"),
contributed to the command palette and to the tree view's title bar. Only one panel exists
at a time; invoking the command again reveals the existing panel instead of opening a
second one.

## 5. Content extraction

This is the highest-risk part of the sub-project. The Claude Code transcript format is
undocumented and changes between releases; every rule below must be validated against real
logs, not only fixtures.

### 5.1 Current action

Derived from the last `tool_use` block of the agent's most recent assistant message.

| Tool | Rendered action |
|---|---|
| `Read` | `Reading <basename>` |
| `Edit`, `Write`, `NotebookEdit` | `Editing <basename>` |
| `Bash` | `Running <first 30 chars of command>` |
| `Grep`, `Glob` | `Searching for <pattern>` |
| `Agent`, `Task` | `Delegating to <subagent_type>` |
| `WebSearch`, `WebFetch` | `Researching` |
| `TodoWrite` | `Planning` |
| anything else | `Working` |

Rules:

- An assistant message with text but no `tool_use` renders `Thinking`.
- Bookkeeping entries (`attachment`, `last-prompt`, `queue-operation`, `ai-title`) carry no
  `message` field and are skipped — gating on `type` alone would misread them as turns.
- An agent whose status is `stopped` has no action and shows no bubble.
- Unknown tool names must fall back to `Working`, never throw and never render a raw id.

### 5.2 Subagent transcripts

Subagent transcripts live at `<session-dir>/subagents/agent-<id>.jsonl` and are not read
today. `subagentTranscriptReader.ts` reads them with the same incremental strategy already
used by `LogParser`: cache a byte offset per file, read only appended bytes.

Only subagents currently in `status: 'working'` are read. A completed subagent's transcript
is never opened — it cannot produce a new action, and reading them all would multiply I/O
by the number of finished agents in the session.

### 5.3 Recent-entries buffer

`recentEntries.ts` keeps, per agent, a ring buffer of the last **20** entries. Each entry
is `{ role, text, tool?, at }` with `text` truncated to **2000 characters** (truncation
marked with an ellipsis). Buffers exist only for agents present in the current snapshot;
an agent that disappears has its buffer dropped.

Worst-case memory is bounded: 20 × 2 KB × agent count. Agents tracked are capped at **50**;
beyond that, the oldest-idle agents are dropped from tracking first.

## 6. Protocol

All messages are JSON over `postMessage`. Full snapshots, not deltas — deltas are a
premature optimisation at this scale and a source of state-drift bugs.

```ts
// extension → webview
type ToWebview =
  | { type: 'snapshot'; agents: AgentView[]; truncated: number }
  | { type: 'feed'; agentId: string; entries: FeedEntry[] }
  | { type: 'monitoringDisabled' };

interface AgentView {
  id: string;
  kind: 'session' | 'subagent';
  parentId?: string;          // set for subagents
  name: string;               // session title or subagent name
  model?: string;
  projectName: string;
  brand: 'claude-code' | 'antigravity';
  status: 'working' | 'stopped';
  action?: string;            // §5.1; absent when stopped
  lastActivityAt: number;
}

interface FeedEntry {
  role: 'assistant' | 'user';
  text: string;               // truncated to 2000 chars
  tool?: string;
  at: number;
}

// webview → extension
type ToExtension =
  | { type: 'ready' }
  | { type: 'openFeed'; agentId: string }
  | { type: 'closeFeed' }
  | { type: 'openLog'; agentId: string }
  | { type: 'openProject'; agentId: string };
```

**`snapshot`** is sent on every provider change and whenever the panel becomes visible.
`truncated` carries how many agents exceeded the visible cap (§7).

**`feed`** is sent **only while a side panel is open**, for that one agent, and refreshed on
each provider change. Shipping 20 entries for every agent on every tick would push megabytes
into the webview that nobody is reading.

**Ordering.** The webview sends `ready` after Phaser boots; the extension holds the first
`snapshot` until then, so no message is dropped against an unmounted scene.

## 7. World and characters

- **Map:** fixed 40×24 tiles at 16px, rendered at integer scale to fit the panel. No camera
  panning, no zoom, no scrolling — the whole office is always on screen.
- **Character identity:** the sprite variant is chosen by a stable hash of the agent name,
  so the same `debugger` is always the same person across refreshes. Sessions and subagents
  use visually distinct sprite sets. Brand is a colour variation.
- **Spawn / despawn:** an agent appearing in a snapshot walks in from a door tile; an agent
  absent from a snapshot walks out and is removed. A `stopped` agent stays as an idle sprite
  until it disappears from the snapshot entirely.
- **Movement (v1):** wander between random floor points at a slow walk, pausing between
  legs. Movement carries no meaning yet — that is sub-project 2, and the simulation API is
  shaped so a target-selection strategy can be swapped in without touching the renderer.
- **Depth sorting:** by Y coordinate, so characters correctly overlap.
- **Bubbles:** DOM elements anchored to each sprite's screen position, updated every frame
  via `transform`. Text is the action string truncated to 40 characters. Bubbles render only
  for `working` agents. Clicking one sends `openFeed`.
- **Capacity:** at most **24** characters are drawn. Beyond that, working agents win over
  idle ones, most-recent activity breaks ties, and the overflow is shown as a counter chip
  (`+7 waiting`). Silently dropping agents is not acceptable — the count must be visible.

## 8. Assets

Sprites must be redistributable from a public Apache-2.0 repository, which rules out the
common paid pixel-office packs.

**Selection gate — first task of implementation, before any rendering work.** Identify a
CC0 (or equivalently permissive) top-down pack providing: floor and wall tiles, basic office
furniture, and at least two character sprite sets with 4-direction walk cycles. Record the
pack, its licence, and its source URL in `resources/ASSETS.md`, and add the licence text to
the repository.

If no such pack is found, stop and escalate rather than substituting a paid pack or
generating sprites — the licence constraint is not negotiable, but the visual style is, and
that trade is the user's to make.

## 9. Errors and performance

- **Parsing never throws.** Every `fs` / `JSON.parse` call in the new modules is wrapped in
  try/catch that logs via `logDebug` and returns an empty or fallback value. A malformed
  transcript line blanks one bubble; it never breaks the office or the tree.
- **The webview is disposable.** Closing the panel stops snapshots and feeds. Reopening
  rebuilds from the current provider state; no state survives in the webview.
- **Render pauses when hidden.** The Phaser loop runs only while `panel.visible` is true.
  A backgrounded tab consumes no CPU.
- **No new polling.** The office is driven entirely by the provider's existing watcher and
  15s timer.
- **Monitoring disabled.** When `agentville.enabled` is false, the panel shows a static
  disabled state and receives no snapshots.

## 10. Testing

Unit-tested in vitest (no DOM, no `vscode`):

- `activityExtractor` — every row of the §5.1 table, plus: no `tool_use`, unknown tool,
  bookkeeping entries, malformed JSON, empty file.
- `recentEntries` — ring eviction at 20, truncation at 2000 chars, buffer dropped when the
  agent disappears, the 50-agent cap.
- `subagentTranscriptReader` — incremental offset behaviour, missing file, truncated file.
- `officeSnapshot` — `Session[]` → `AgentView[]`, the 24-character cap and `truncated`
  count, ordering rules.
- `webview/simulation/**` — spawn, despawn, target selection, depth ordering, capacity.

Not unit-tested: `officePanel.ts` (vscode glue), `webview/render/**` (Phaser),
`webview/ui/**` (DOM).

**Real-log validation is a required acceptance step, not optional.** Fixtures have already
hidden a parser bug in this project once, with 153 tests green. Before this sub-project is
called done, the extractor must be run against real transcripts under
`~/.claude/projects/**`, including a session with live subagents, and the observed actions
compared against what Claude Code was actually doing.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Transcript format drifts and actions become wrong or empty | Unknown shapes fall back to `Working`; the existing Claude-version compatibility warning already flags untested versions |
| Reading subagent transcripts multiplies file I/O | Only `working` subagents are read, incrementally, byte-offset cached |
| No suitable CC0 office pack exists | Explicit gate in §8 — escalate before building on a licence that cannot ship |
| Phaser bundle inflates the `.vsix` | Expected ~1.2 MB; the release workflow's 2 MB guard still applies and must be re-checked when the webview bundle lands |
| Simulation logic drifts into Phaser, losing testability | ESLint `boundaries` rule forbids Phaser imports under `webview/simulation/**` |

## 12. Acceptance criteria

1. A command opens the office in an editor tab; the tree view is unchanged and still works.
2. Every working session and subagent appears as a character; characters enter on start and
   leave on completion.
3. Each working character carries a bubble showing a correct, human-readable current action.
4. Clicking a bubble opens a side panel with that agent's last ~20 entries, updating live.
5. With more than 24 agents, the overflow count is visible rather than silently dropped.
6. Closing the panel or disabling monitoring stops all office work; CPU is idle when hidden.
7. `npx tsc --noEmit`, `npm run lint` and `npm run test` are green.
8. The extractor has been validated against real transcripts, including live subagents.
9. `resources/ASSETS.md` records the asset pack, its licence and its source.
