import { normalizeForKey } from './sessionDedupe';

export interface LogEntryForName {
  role?: string;
  type?: string;
  // Claude Code marks internal/scaffolding user turns (the slash-command caveat, command
  // expansions) with isMeta:true — these are not the user's prompt.
  isMeta?: boolean;
  message?: {
    role?: string;
    content?:
      | Array<{
          type: string;
          text?: string;
        }>
      | string;
  };
  content?: Array<{ type: string; text?: string }> | string;
  prompt?: string;
}

// Slash-command scaffolding (and background-agent notifications) that a recent Claude Code
// update records as the first `type:"user"` turns. Used as a title, they made every session
// opened with a slash command share one identical title, collapsing distinct concurrent
// sessions into a single dedupe slot. Skip any turn whose text is purely one of these blocks.
const SCAFFOLD_PREFIXES = [
  '<local-command-',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<task-notification>',
];

function isScaffold(text: string): boolean {
  const t = text.trimStart();
  return SCAFFOLD_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * The title the user typed to rename the session, when this entry is a rename. Claude Code writes
 * one `type:"custom-title"` entry per rename, so the last one in the transcript is the name it
 * shows — and being an explicit human choice, it outranks anything derived or generated.
 *
 * Since Claude Code 2.1.223, a session also gets a `custom-title` entry auto-stamped to its own
 * git-worktree name every time it enters that worktree — the same entry type, indistinguishable
 * by shape from a real rename. Trusting it made every session that ever entered a given worktree
 * share the identical sessionTitle, collapsing genuinely distinct sessions onto one
 * sessionDedupe.getDedupeKey() slot (real capture: `{"type":"custom-title",
 * "customTitle":"structured-logging",...}`, byte-identical across four unrelated sessions that
 * had all entered the "structured-logging" worktree). `knownWorktreeName` is the name the SAME
 * transcript already logged via its own `type:"worktree-state"` entry (projectPathResolver.ts's
 * detectWorktreeName tracks it on `session.worktreeName` as a one-way latch — see its KNOWN
 * LIMITATION comment for why); a match means this is Claude Code's own auto-label, not user
 * intent, so it's rejected here — the caller then falls back to whatever the first-real-prompt/
 * ai-title logic would otherwise produce. Mirrors the
 * SCAFFOLD_PREFIXES handling above: same class of "don't trust it just because it arrived as a
 * custom-title entry" problem, different trigger.
 *
 * The match is via normalizeForKey, not raw `===`: Claude Code substitutes `/` with `+` when it
 * stamps a slash-containing worktree name into customTitle — real capture, two unrelated
 * sessions: `worktreeName:"feat/42-example-generic-feature-name"` stamped as
 * `customTitle:"feat+42-example-generic-feature-name"`. A slash-containing name is the
 * mainstream case (`feature/…`, `fix/…`, `chore/…`-derived worktrees), not an edge case, so raw
 * equality missed most real auto-stamps and reopened the exact collision this function exists to
 * close. normalizeForKey already folds any run of non-alphanumeric characters (covering both `/`
 * and `+`, whatever else Claude Code might substitute) — reusing it here instead of hand-rolling
 * a narrower `/`-only replace is deliberate: it doesn't require enumerating every substitution
 * Claude Code happens to apply, only the ones observed so far. Its lowercasing/diacritic-folding
 * is slightly more aggressive than this comparison strictly needs, so a coincidental later user
 * rename that normalizes identically to a past worktree name would also be (wrongly) rejected —
 * accepted here since sessionDedupe.getDedupeKey() already tolerates that exact class of
 * near-miss for its own, primary purpose.
 */
export function extractRenamedTitle(
  json: { type?: string; customTitle?: string },
  knownWorktreeName?: string,
): string | null {
  if (json.type !== 'custom-title' || typeof json.customTitle !== 'string') return null;
  const title = json.customTitle.trim();
  if (!title) return null;
  if (knownWorktreeName && normalizeForKey(title) === normalizeForKey(knownWorktreeName)) return null;
  return title;
}

export function extractSessionName(json: LogEntryForName): string | null {
  if (json.isMeta === true) return null;
  const name = extractAntigravityName(json) || extractClaudeName(json) || extractGenericName(json);
  if (name === null) return null;
  return isScaffold(name) ? null : name;
}

function extractAntigravityName(json: LogEntryForName): string | null {
  if (json.type !== 'USER_INPUT' || typeof json.content !== 'string') return null;
  const match = json.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (!match) return null;
  // Strip any nested XML/markup tags and collapse whitespace
  return (
    match[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || null
  );
}

function extractClaudeName(json: LogEntryForName): string | null {
  // Claude Code format: top-level type === 'user', role nested in message.
  // Legacy / alternate format: top-level role === 'user'.
  const isUserTurn = json.type === 'user' || json.role === 'user' || json.message?.role === 'user';
  if (!isUserTurn) return null;
  return extractClaudeMessageContentName(json) || extractClaudeContentArrayName(json);
}

function extractClaudeMessageContentName(json: LogEntryForName): string | null {
  const content = json.message?.content;
  // Simple text-only turns carry content as a plain string instead of a content-block array
  // (seen on forked/automated turns, e.g. a hook-spawned review prompt) — extract it directly.
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
    }
  }
  return null;
}

function extractClaudeContentArrayName(json: LogEntryForName): string | null {
  if (Array.isArray(json.content)) {
    for (const block of json.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
    }
  }
  return null;
}

function extractGenericName(json: LogEntryForName): string | null {
  if (json.prompt && typeof json.prompt === 'string') {
    return json.prompt;
  }
  return null;
}
