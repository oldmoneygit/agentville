---
name: reference-transcript-subagent-layout
description: Where Claude Code actually writes subagent transcripts, where a session's log lands after it enters a worktree, and the same-id stub collision that can cause.
metadata:
  type: reference
---

Real on-disk layout under `~/.claude/projects/<encoded-project>/`:

- Session transcript: `<session-id>.jsonl`
- Subagent transcripts: `<session-id>/subagents/agent-<id>.jsonl` — same
  `entrypoint` as the parent (e.g. `claude-vscode`), NOT `sdk*`.
- Next to each one, a `agent-<id>.meta.json` sidecar (1:1, ~200 bytes) holding
  `agentType`, `description`, `toolUseId`, `spawnDepth`, `model`. `toolUseId`
  joins to `SubAgent.id` (both are the launching `tool_use` block's id); the
  filename's id is an unrelated internal one, so never join on the filename.
  `subagentMetadata.ts` uses this to fill in the real agent name and model.
- Background agents launched by `/security-review` and similar: their own
  top-level `<uuid>.jsonl` with `entrypoint: sdk-py`.
- A session that enters a git worktree leaves its main transcript in the **base**
  project directory while its subagent transcripts land in the **worktree's**
  project directory.
- Claude Code's _native_ worktree-entry (`type: 'relocated'` / `type:
'worktree-state'` entries) is different: it relocates the **entire** transcript
  under the worktree's project dir and leaves a same-filename **stub** in the base
  dir (observed: one `custom-title` line, ~138 bytes, vs. 4.25 MB real). Both files
  produce the identical bare `session.id` (`logParser.ts` keys on basename only).

**Why:** `sessionScanner.scanClaudeSubSessions` looks for `<project>/sessions/*.jsonl`,
a path that does not exist in any observed install — so `<id>/subagents/*.jsonl` is
never scanned (76 such files found in one worktree). Benign today, because
`subagentDetector` derives subagents from the parent's own transcript; reading them
as sessions would instead produce dozens of phantom top-level rows, since their
`entrypoint` is not `sdk*` and `isAgentSession` would call them human.
The stub/real same-id pair was worse: `sessionTreeDataProvider`'s `sessions` Map used
to keep whichever file `fs.readdirSync` scanned last (filesystem-dependent order), so
an active session with running subagents could silently vanish, replaced by the
stopped-looking stub. Fixed 2026-08-03 via `sessionDedupe.upsertIfMoreRelevant`,
which tie-breaks any same-id overwrite through the existing `isMoreRelevant`
comparator instead of a blind `Map.set` — with two refinements adversarial review
forced: a same-`logFilePath` candidate always wins unconditionally (it's a fresher
parse of the identical file, not a rival — `isMoreRelevant`'s status-based tiers
would otherwise let a stale cached `'working'` entry block a legitimate re-parse
after e.g. `/clear` or compaction), and a genuine tie across every `isMoreRelevant`
tier (plausible when two files land in the same mtime tick) falls back to comparing
`logFilePath` itself, since `isMoreRelevant`'s own final `id` tiebreak is a no-op
here (`existing.id` always equals `candidate.id` — both equal the map key).

**How to apply:** before changing scanning or nesting, check this layout against a
real install rather than the code's assumption. Relevant to `sessionScanner`,
`sessionAssembly` and `sessionDedupe.findParentSession`. Any new code path that
writes a session into an id-keyed map must go through `upsertIfMoreRelevant`, or the
stub-collision bug reopens. See [[architecture-transcript-bookkeeping-entries]].
