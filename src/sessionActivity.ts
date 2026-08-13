import * as path from 'path';
import { exec } from 'child_process';
import { Session } from './types';
import { logDebug } from './logger';

/**
 * Decide whether a session is still running.
 *
 * `lsof` is the only positive proof, but neither Claude Code nor Antigravity keeps the transcript
 * file descriptor open between appends — in practice it returns nothing, so everything falls to
 * the heuristics below. On Windows `lsof` doesn't exist at all, so there the heuristics are the
 * only path. The old "modified in the last 30s" fallback alone marked a session
 * stopped during any quiet stretch: a backgrounded agent can run for minutes without the parent
 * transcript gaining a single line, which is exactly when the user is watching it work.
 *
 * So: recent write, OR the last entry is a user turn (Claude owes a reply), OR the last turn is a
 * thinking-only block (Claude is mid-reply — its text/tool_use always arrives in a later entry),
 * OR it still has subagents that never reported completion. Those three are capped by
 * IDLE_CEILING so a session abandoned mid-turn, or one whose agent completion notification we
 * missed, eventually goes quiet instead of spinning forever.
 *
 * The "last entry is a user turn" reading has one carve-out: Claude Code writes the user's own
 * Esc-interruption as a `type: 'user'` turn too (see logParser.ts's INTERRUPTION_TEXTS), and
 * Claude owes that turn nothing — the user killed it, not Claude. Without the carve-out, an
 * interrupted session read as 'working' for up to IDLE_CEILING after the user backed out of it.
 * The other two conditions are untouched: a still-thinking or still-running-subagent session
 * stays 'working' regardless of the interruption.
 */
// Shared with subagentMetadata.ts's best-effort grandchild status (mtime of a child's
// sidecar-sibling .jsonl) — one definition of "recent" for the whole codebase, exported so it
// isn't duplicated as a second magic-number literal there.
export const RECENT_WRITE = 60 * 1000;
// Also shared with subagentMetadata.ts: a grandchild's status has NO signal besides mtime (no
// awaitingReply/isThinking/hasRunningAgents to fall back on the way computeSessionStatus below
// does), so it needs the same generous ceiling this function uses for a session that's gone
// quiet mid-turn — not the much tighter RECENT_WRITE, which is a "just wrote a moment ago"
// signal for a DIFFERENT purpose. See subagentMetadata.ts's computeChildStatus.
export const IDLE_CEILING = 30 * 60 * 1000;

export function computeSessionStatus(session: Session, openFiles: Set<string>): 'working' | 'stopped' {
  if (openFiles.has(path.normalize(session.logFilePath))) {
    return 'working';
  }
  const idle = Date.now() - session.lastInteractionTime;
  if (idle < RECENT_WRITE) {
    return 'working';
  }
  if (idle >= IDLE_CEILING) {
    return 'stopped';
  }
  const awaitingReply = session.lastEntryType === 'user' && !session.lastEntryIsInterruption;
  const isThinking = session.lastEntryIsThinking === true;
  const hasRunningAgents = session.subagents.some((sub) => sub.status === 'working');
  return awaitingReply || isThinking || hasRunningAgents ? 'working' : 'stopped';
}

/** Set of transcript files currently held open, per `lsof`. Scoped to ~/.claude and ~/.gemini to
 * avoid a full-system scan. Resolves to an empty set on any error (the heuristics cover the rest),
 * and on Windows, where `lsof` does not exist. */
export function getOpenLogFiles(homeDir: string): Promise<Set<string>> {
  // Windows has no `lsof`. Rather than spawn a doomed subprocess on every refresh, skip straight
  // to the empty set — `computeSessionStatus` treats that exactly like the (already normal) case
  // where lsof returns nothing, and its heuristics carry the whole detection there.
  if (process.platform === 'win32') {
    return Promise.resolve(new Set());
  }
  return new Promise((resolve) => {
    const openFiles = new Set<string>();

    const claudePath = path.join(homeDir, '.claude');
    const geminiPath = path.join(homeDir, '.gemini');

    // exec (shell) is used for the `lsof | grep` pipe. The only interpolated value is os.homedir(),
    // which is trusted (not external input), so there is no injection surface here.
    const cmd = `lsof -Fn "${claudePath}" "${geminiPath}" 2>/dev/null | grep -E '\\.jsonl$' || true`;

    logDebug(`executing: getOpenLogFiles() cmd: ${cmd}`);
    exec(cmd, (err, stdout) => {
      if (err) {
        logDebug(`lsof exec error: ${err.message}`);
      }
      if (stdout) {
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.startsWith('n')) {
            const filePath = line.substring(1).trim();
            openFiles.add(path.normalize(filePath));
          }
        }
      }
      logDebug(`getOpenLogFiles(): Found ${openFiles.size} open log files in lsof`);
      resolve(openFiles);
    });
  });
}
