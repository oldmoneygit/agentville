import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Session, SubAgent } from './types';
import { extractRenamedTitle, extractSessionName } from './nameExtractor';
import { ProjectPathResolver } from './projectPathResolver';
import { detectSubagents } from './subagentDetector';
import { enrichSubagentMetadata } from './subagentMetadata';
import { LogEntry } from './transcriptEntry';

// Re-exported so existing importers (e.g. subagentDetector) keep resolving LogEntry from here.
export type { LogEntry } from './transcriptEntry';

interface NewLinesContext {
  filePath: string;
  fileSize: number;
  lastReadOffset: number;
  session: Session;
  stats: fs.Stats;
}
interface LogLineContext {
  line: string;
  session: Session;
  currentSubagents: Map<string, SubAgent>;
  stats: fs.Stats;
}

// Claude Code stamps no structural field for an Esc-interruption — no `stop_reason`, no `isMeta`,
// no `origin`. The only signal is this literal sentinel text, standing alone as the entire user
// turn. Confirmed against the local transcript corpus (`grep -rhoa '\[Request interrupted[^]]*\]'
// ~/.claude/projects --include='*.jsonl' | sort | uniq -c`): exactly two variants occur at
// meaningful volume (hundreds of occurrences each); nothing else was observed, so nothing else is
// matched here. Fragile by nature — text observed as of Claude Code 2.1.222 — a future wording
// change silently stops matching until this list is updated. Antigravity has no equivalent
// marker at all, so its turns simply never match; no separate no-op branch is needed for it.
const INTERRUPTION_TEXTS = new Set<string>([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

const CLAUDE_CODE_BRAND = 'claude-code' as const;

export class LogParser {
  private cache = new Map<string, { lastReadOffset: number; session: Session }>();
  private projectPaths = new ProjectPathResolver();
  private claudeProjectsPath: string;

  constructor(claudeProjectsPath?: string) {
    this.claudeProjectsPath = claudeProjectsPath ?? path.join(os.homedir(), '.claude', 'projects');
  }

  public parse(filePath: string, type: 'claude-code' | 'antigravity'): Session {
    try {
      let cacheEntry = this.cache.get(filePath);

      if (!fs.existsSync(filePath)) {
        return this.createEmptySession(filePath, type);
      }

      const stats = fs.statSync(filePath);
      const fileSize = stats.size;

      if (cacheEntry && fileSize < cacheEntry.lastReadOffset) {
        cacheEntry = undefined;
      }

      if (!cacheEntry) {
        const session = this.createEmptySession(filePath, type);
        session.lastInteractionTime = stats.mtimeMs;
        cacheEntry = { lastReadOffset: 0, session };
        this.cache.set(filePath, cacheEntry);
      }

      const { session, lastReadOffset } = cacheEntry;

      if (fileSize > lastReadOffset) {
        cacheEntry.lastReadOffset = this.parseNewLines({ filePath, fileSize, lastReadOffset, session, stats });
      }

      return session;
    } catch {
      return this.createEmptySession(filePath, type);
    }
  }

  /** Returns the byte offset the next read should resume from. */
  private parseNewLines(ctx: NewLinesContext): number {
    const { filePath, fileSize, lastReadOffset, session, stats } = ctx;
    const fd = fs.openSync(filePath, 'r');
    const bufferSize = fileSize - lastReadOffset;
    const buffer = Buffer.alloc(bufferSize);

    try {
      fs.readSync(fd, buffer, 0, bufferSize, lastReadOffset);
      const newContent = buffer.toString('utf8');

      // Claude Code writes one line at a time; a chunk read mid-write can end partway through the
      // line currently being flushed (no trailing '\n' yet). That fragment must not be parsed now:
      // it either fails JSON.parse (silently dropped below) or, worse, could coincidentally parse
      // as something else — and since the offset would already sit past it, the real entry is lost
      // forever, because the next read starts after it, mid-JSON, and never resyncs. So hold the
      // fragment back and don't advance the offset past it, leaving it to be re-read whole once the
      // writer finishes the line.
      const endsWithNewline = newContent.endsWith('\n');
      const lines = newContent.split('\n');
      const incompleteTail = endsWithNewline ? '' : (lines.pop() ?? '');

      const currentSubagents = new Map<string, SubAgent>();
      for (const sub of session.subagents) {
        currentSubagents.set(sub.id, sub);
      }

      for (const line of lines) {
        this.parseLogLine({ line, session, currentSubagents, stats });
      }

      session.subagents = Array.from(currentSubagents.values());
      // Runs once per parseNewLines() call (i.e. only when this file actually grew), and only
      // reads a sidecar for subagents still missing a name/model — never per render.
      enrichSubagentMetadata(session);
      session.lastInteractionTime = stats.mtimeMs;

      // Byte length, not `.length` (UTF-16 code units): transcripts carry multibyte UTF-8 (accented
      // text, emoji), so a char-counted retreat would land the next read mid-character instead of
      // at the start of the held-back fragment.
      return fileSize - Buffer.byteLength(incompleteTail, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  private parseLogLine(ctx: LogLineContext): void {
    const { line, session, currentSubagents, stats } = ctx;
    if (!line.trim()) {
      return;
    }
    try {
      const json = JSON.parse(line) as LogEntry;
      // Subagent transcripts (<sessionId>/subagents/agent-*.jsonl, or same-dir sidechains) mark
      // every entry isSidechain:true. Flag the session so it's excluded from the standalone list —
      // otherwise the recursive **/*.jsonl watcher surfaces it as a phantom top-level session whose
      // title is the subagent's task prompt. Its status is shown via the parent's tool_use pairing.
      if (json.isSidechain === true) {
        session.isSidechain = true;
      }
      this.trackTurnSignals(json, session);
      if (typeof json.entrypoint === 'string') {
        session.entrypoint = json.entrypoint;
      }
      if (typeof json.version === 'string') {
        session.claudeVersion = json.version;
      }
      this.parseTimestamp(json, session, stats);
      this.projectPaths.detectGitBranch(json, session);
      this.projectPaths.detectWorktreeName(json, session);
      this.projectPaths.detectProjectPath(json, session);
      this.detectSessionModel(json, session);

      this.detectSessionTitle(json, session);

      detectSubagents(json, currentSubagents);
    } catch {
      // Ignore JSON parse errors
    }
  }

  /**
   * Record whether Claude still owes this session a reply.
   *
   * All three signals describe the SESSION's own conversation, so a sidechain entry must never
   * set them: subagent turns can be interleaved into the parent's file, and a subagent thinks and
   * replies exactly like the session does — letting those through would report the parent as
   * working off the subagent's turn.
   *
   * Claude Code streams a reasoning block as its own entry carrying nothing but `thinking`; the
   * turn's text/tool_use always lands in a later entry. So a transcript whose last conversational
   * turn is thinking-only is one Claude is still working on. Only turns carrying `message` update
   * any of the three flags, so a trailing bookkeeping entry doesn't clear or corrupt any signal.
   *
   * lastEntryIsInterruption is recomputed unconditionally on every message-bearing turn, exactly
   * like lastEntryType above — so it self-clears the moment a real turn follows an interruption,
   * instead of latching true forever once set.
   */
  private trackTurnSignals(json: LogEntry, session: Session): void {
    if (json.isSidechain === true) {
      return;
    }
    // Claude Code writes bookkeeping entries between turns — `attachment` (by far the most
    // frequent), `last-prompt`, `ai-title`, `queue-operation`, `file-history-snapshot` — that
    // carry a `type` but no `message`. Without this gate, one of those landing right after a
    // tool_result overwrites lastEntryType away from 'user', hiding that Claude still owes a
    // reply for as long as the gap before its next turn lasts. Antigravity turns never carry
    // `message` either, so this also leaves its lastEntryType/lastEntryIsThinking unset — same
    // net effect as before, since computeSessionStatus only compares lastEntryType against the
    // literal 'user', which no Antigravity `type` value ever equals.
    if (!json.message) {
      return;
    }
    if (typeof json.type === 'string') {
      session.lastEntryType = json.type;
    }
    session.lastEntryIsInterruption = this.isInterruptionEntry(json);
    const blocks = Array.isArray(json.message.content) ? json.message.content : null;
    if (blocks) {
      // LogEntry types a content block as always-present, but this is untrusted transcript
      // data — a real line can carry a null/undefined element — so the callback param is typed
      // to match that reality rather than the (optimistic) shared LogEntry shape.
      session.lastEntryIsThinking = blocks.some(
        (block: { type: string } | null | undefined) => block?.type === 'thinking',
      );
    }
  }

  /**
   * True when this turn's entire text is Claude Code's interruption sentinel (INTERRUPTION_TEXTS
   * above) — the user pressed Esc rather than sending a real prompt. Matched by exact text (after
   * trim), never `includes()`: a user can legitimately quote this phrase inside a real prompt, and
   * a substring match would wrongly mark that session as no longer awaiting a reply.
   *
   * A multi-block content array is never treated as an interruption, even when one block matches
   * exactly — the real interruption entry is always a single lone text block, so extra blocks mean
   * this is a genuine, richer user turn that merely happens to contain the phrase.
   */
  private isInterruptionEntry(json: LogEntry): boolean {
    if (json.type !== 'user') {
      return false;
    }
    const content = json.message?.content;
    let text: string | undefined;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'text') {
      text = content[0].text;
    }
    return typeof text === 'string' && INTERRUPTION_TEXTS.has(text.trim());
  }

  private detectSessionTitle(json: LogEntry, session: Session): void {
    // A rename the user typed wins over anything derived. A later rename still applies (each one
    // is its own entry), but no generated title may take it back — hence the latch rather than
    // relying on assignment order, since an `ai-title` can land after the rename.
    // `session.worktreeName` (set by projectPaths.detectWorktreeName from an earlier
    // `worktree-state` entry) lets extractRenamedTitle reject Claude Code's own auto-stamped
    // custom-title instead of latching it as if the user had renamed the session.
    const renamed = extractRenamedTitle(json, session.worktreeName);
    if (renamed) {
      // Not truncated at 60 like a derived title below: this is the exact text the user typed,
      // and it is what Claude Code itself shows. The tree view elides anything too long.
      session.sessionTitle = renamed;
      session.nameFromPrompt = true;
      session.titleIsCustom = true;
      return;
    }
    if (session.titleIsCustom) {
      return;
    }
    if (!session.nameFromPrompt) {
      const extractedName = extractSessionName(json);
      if (extractedName) {
        session.sessionTitle =
          extractedName.length > 60 ? extractedName.substring(0, 60).trimEnd() + '...' : extractedName;
        session.nameFromPrompt = true;
      }
    }
    // Claude Code's own generated title, when present, is cleaner than the first prompt
    // (which can be a raw diff, a forked review prompt, etc.) — always prefer it.
    if (json.type === 'ai-title' && typeof json.aiTitle === 'string' && json.aiTitle.trim()) {
      session.sessionTitle = json.aiTitle.trim();
      session.nameFromPrompt = true;
    }
  }

  private parseTimestamp(json: LogEntry, session: Session, stats: fs.Stats): void {
    if (json.timestamp) {
      const t = Date.parse(json.timestamp);
      if (!isNaN(t)) {
        session.lastInteractionTime = t;
      }
    } else if (json.time) {
      const t = Date.parse(json.time);
      if (!isNaN(t)) {
        session.lastInteractionTime = t;
      }
    } else if (typeof json.created === 'number') {
      session.lastInteractionTime = json.created;
    } else {
      session.lastInteractionTime = stats.mtimeMs;
    }
  }

  private detectSessionModel(json: LogEntry, session: Session): void {
    // Assistant turns carry the main-loop model (e.g. "claude-sonnet-5"). Keep the latest.
    if (json.type === 'assistant' && json.message?.model) {
      session.model = json.message.model;
    }
  }

  private createEmptySession(filePath: string, type: 'claude-code' | 'antigravity'): Session {
    const fileBasename = path.basename(filePath, '.jsonl');

    let projectDir: string;
    if (type === CLAUDE_CODE_BRAND) {
      const relative = path.relative(this.claudeProjectsPath, filePath);
      projectDir = relative.split(path.sep)[0] || '';
    } else {
      // brain/<conversationId>/.system_generated/logs/transcript.jsonl — the conversation id is
      // three levels up. Every Antigravity transcript is literally named `transcript.jsonl`, so
      // using the basename as the session id collapsed all of them onto one Map slot and only the
      // last one parsed ever showed up in the tree.
      projectDir = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
    }

    const decodedPath =
      type === CLAUDE_CODE_BRAND
        ? this.projectPaths.decodeClaudeProjectPath(projectDir)
        : path.dirname(path.dirname(path.dirname(filePath)));
    const sessionId = type === CLAUDE_CODE_BRAND ? fileBasename : projectDir;
    const projectName =
      type === CLAUDE_CODE_BRAND ? path.basename(decodedPath) || projectDir : `Session ${projectDir.substring(0, 8)}`;

    return {
      id: sessionId,
      projectHash: projectDir,
      projectPath: decodedPath,
      projectName: projectName,
      gitBranch: 'unknown',
      status: 'stopped',
      lastInteractionTime: Date.now(),
      subagents: [],
      logFilePath: filePath,
      type,
      nameFromPrompt: false,
    };
  }
}
