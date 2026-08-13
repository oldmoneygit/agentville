---
name: architecture-transcript-bookkeeping-entries
description: Claude Code intercalates bookkeeping entries with no `message` field after every real turn — any activity heuristic must gate on `message`, never on `type` alone.
metadata:
  type: architecture
---

Claude Code writes non-conversational bookkeeping entries between real turns:
`attachment` (by far the most frequent — 86 in a single 104-line transcript),
`last-prompt`, `queue-operation`, `ai-title`, `file-history-snapshot`. They carry a
`type` but **never** a `message` field. Only `type: 'user'` and `type: 'assistant'`
carry `message`. Antigravity entries never carry `message` either, and its `type`
values are UPPER_SNAKE_CASE (`USER_INPUT`, `PLANNER_RESPONSE`, `RUN_COMMAND`).

**Why:** a "last entry type" tracked from `type` alone gets overwritten by the
bookkeeping entry that lands right after a real turn, silently erasing the
"Claude owes a reply" signal. That made live sessions render as stopped once past
the 60s recent-write window — including every long thinking turn, since nothing is
appended to the transcript while the model thinks (a real 116s gap was measured
between a `tool_result` and the next `thinking` entry).

**How to apply:** any turn-level signal in `logParser.trackTurnSignals` (or a new
activity heuristic) must gate on the presence of `json.message`, not on `type`.
Gating on `message` keeps the core brand-agnostic — prefer it over whitelisting the
Claude-Code-specific `'user'`/`'assistant'` literals. See [[architecture-no-public-transcript-schema]]
and [[reference-transcript-subagent-layout]].
