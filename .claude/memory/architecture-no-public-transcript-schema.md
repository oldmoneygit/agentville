---
name: no-public-transcript-schema
description: Claude Code's on-disk JSONL transcript format has no official schema — only real captured logs are reliable evidence
metadata:
  type: architecture
---

Claude Code's `~/.claude/projects/<project>/<sessionId>.jsonl` transcript format (and the
`<sessionId>/subagents/agent-*.jsonl` + `.meta.json` layout) is an undocumented internal
implementation detail with no version field and no stability guarantee. Anthropic's own docs
(code.claude.com/docs/en/sessions) say explicitly: it changes between CLI releases, and scripts
that parse it directly can break on any release — the recommended path for external tooling is
`/export`, not this parser. Community reverse-engineering projects exist (e.g.
`daaain/claude-code-log` has a typed parser + round-trip schema-drift validator) but are
themselves unofficial and non-authoritative.

**Why:** confirmed 2026-07-17 via official docs + web research (context7/WebSearch) while
debugging why subagent status tracking silently broke — the code had assumed a top-level
`tool_use_id` field that never exists in real transcripts (completions are nested inside
`message.content[]`), and `message.content` can be a plain string instead of a block array on
some turns. Neither shape is documented anywhere; both were only found by reading real log files
under `~/.claude/projects/`.

**How to apply:** this project (`claude-agents-view-vscode`) has no schema to consult in advance.
Before adding or changing any parsing logic in `logParser.ts` / `subagentDetector.ts` /
`nameExtractor.ts`, pull a fresh real sample from `~/.claude/projects/` (or
`~/.gemini/antigravity-ide/brain` for Antigravity) and inspect it directly — don't infer field
shapes from memory, from the public Anthropic Messages API docs (those only cover the
`message.content[]` block shapes, not the CLI's own wrapper fields like `type`, `gitBranch`,
`ai-title`, `queue-operation`), or from this format having "always" looked a certain way in an
older sample. Treat every assumption about the format as something that needs a real specimen to
back it up.
