---
name: architecture-fixtures-hide-real-log-shapes
description: Green fixtures prove nothing about this parser — validate every log-format change by running it against real transcripts before calling it done.
metadata:
  type: architecture
---

Two features in one session passed **two code reviews and 153 green tests**, then failed
the first run against real transcripts:

- Grandchild nesting attached **zero** children for classic nested dispatch (~10x the
  commonest case: 125 sidecars vs 11 forked-skill ones). Cause: `needsEnrichment` skipped
  any subagent that already had `name`+`model` from its launch — measured at **113 of 113**
  real classic dispatches — so `agentId` was never filled and the `parentAgentId` join
  could never match. Every fixture used the helper's default `name: 'Agent'`, which is
  exactly the shape that made the broken path unreachable.
- The same features were nearly shipped reading the _wrong_ file's growth as their refresh
  signal, because a background subagent writes only two lines to the parent transcript.

**Why:** fixtures encode what the author believed the format is; the bug is always in the
gap between that belief and what Claude Code actually writes. A fixture written from the
same wrong belief as the code passes and proves nothing. Reviews don't close this gap
either — both reviewers read the same code and the same fixtures.

**How to apply:** for any change to parsing, detection or nesting, the definition of done
includes running the real parser over real `~/.claude/projects/**` transcripts, before/after,
with control files to prove no regression — not just `npm run test`. Prefer measuring
incidence in the corpus (`grep`/`jq` over the sidecars and JSONL) to reasoning about which
shape is "typical". Copy transcripts to a scratchpad first: live ones are still being
written. See [[architecture-subagent-dispatch-mechanisms]] and
[[architecture-no-public-transcript-schema]].
