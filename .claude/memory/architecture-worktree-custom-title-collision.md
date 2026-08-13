---
name: architecture-worktree-custom-title-collision
description: Claude Code auto-stamps a custom-title entry equal to the worktree's bare name (with / substituted by +) for every session entering that worktree; treating it as a real rename collapses distinct sessions onto the same dedupe key and silently drops them from the tree.
metadata:
  type: architecture
---

Claude Code writes a `type:"custom-title"` transcript entry whose `customTitle` equals the git
worktree's bare name (e.g. `"structured-logging"`) every time a session enters that worktree —
indistinguishable at a glance from a genuine user rename. When the worktree name contains `/`
(any `feature/…`/`fix/…`-derived name), Claude Code substitutes `+` for `/` in the stamped title
(`feat/6-x` → `feat+6-x`), so even a comparison against the tracked worktree name (from the
earlier `type:"worktree-state"` entry's `worktreeSession.worktreeName`) fails if done with raw
`===`.

**Why:** `nameExtractor.extractRenamedTitle` used to latch any `custom-title` as
`titleIsCustom = true` permanently. Since `sessionDedupe.getDedupeKey()` includes the session
title, every session that ever entered a given worktree collapsed onto the identical dedupe key,
and `upsertIfMoreRelevant` keeps only one winner per key — the rest silently vanished from the
tree, including, in the incident that surfaced this, a session running live subagents. Cost a
real-transcript investigation plus a HIGH-severity follow-up (the `/`→`+` case) caught only by
code-reviewer diffing against a _second_ real project's transcripts, not the one that prompted
the original fix.

**How to apply:** any comparison against an auto-stamped title must go through a normalizer
tolerant of Claude Code's own character substitutions (reuse `sessionDedupe.normalizeForKey`
rather than a bespoke `/`-only fix — it closes the general case, not just the one observed
instance), never raw `===`. The one-way `worktreeName` latch (never cleared on worktree exit) is
a known, deliberately-accepted limitation: a "clear on exit" fix was tried and reverted after real
data showed a transient relocate-out-and-back with a repeated stamp defeats it — there is no
reliable "permanently left the worktree" signal in the real corpus. See
[[architecture-subagent-dispatch-mechanisms]] and [[reference-transcript-subagent-layout]] for the
sibling collision class (same-id stub overwrite — a different mechanism, same family of bug).
