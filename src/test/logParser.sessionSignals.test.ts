import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LogParser } from '../logParser';
import { getDedupeKey } from '../sessionDedupe';

// Signals that tell the sidebar what a session is *doing* and what to call it: the user's own
// rename (`type:"custom-title"`), and whether Claude is mid-turn (a thinking-only last turn).
describe('LogParser session signals', () => {
  const tempDir = path.join(os.tmpdir(), 'claude-agents-signals-test');
  const tempFilePath = path.join(tempDir, 'test-session.jsonl');

  beforeEach(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    fs.writeFileSync(tempFilePath, '');
  });

  afterEach(() => {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
  });

  it('flags a transcript whose last turn is a thinking block, and clears it once the answer lands', () => {
    // Claude Code writes a reasoning block as an entry containing nothing but `thinking`; the
    // turn's text/tool_use always arrives later. So thinking-last means the reply is still coming.
    const parser = new LogParser();

    const thinking = {
      timestamp: '2026-07-17T19:00:00.000Z',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing options' }] },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(thinking) + '\n');
    expect(parser.parse(tempFilePath, 'claude-code').lastEntryIsThinking).toBe(true);

    const answer = {
      timestamp: '2026-07-17T19:00:05.000Z',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the plan' }] },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(answer) + '\n');
    expect(new LogParser().parse(tempFilePath, 'claude-code').lastEntryIsThinking).toBe(false);
  });

  it('does not let an interleaved subagent turn set the parent session as thinking', () => {
    // Subagent turns can be written into the parent's own file, flagged isSidechain. A subagent
    // thinks exactly like the session does, so counting its turns would report the parent as
    // working off someone else's reasoning.
    const parser = new LogParser();

    const lines = [
      {
        timestamp: '2026-07-17T19:00:00.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the plan' }] },
      },
      {
        timestamp: '2026-07-17T19:00:05.000Z',
        type: 'assistant',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'subagent reasoning' }] },
      },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    expect(parser.parse(tempFilePath, 'claude-code').lastEntryIsThinking).toBe(false);
  });

  it('keeps a rename in place when a later empty rename arrives', () => {
    // Claude Code has never been observed emitting a "clear the rename" entry, and the format
    // gives no way to tell one apart from an unrelated line. Locking the current behaviour in:
    // a rename, once made, stands. Revisit if a real clear-title entry ever shows up.
    const parser = new LogParser();

    const lines = [
      { type: 'custom-title', customTitle: 'Auth spike' },
      { type: 'custom-title', customTitle: '' },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    expect(parser.parse(tempFilePath, 'claude-code').sessionTitle).toBe('Auth spike');
  });

  it('keeps the thinking flag when a non-conversational entry trails it', () => {
    // A `custom-title` or snapshot entry can land after the thinking block; it says nothing about
    // whether the turn finished, so it must not clear the signal.
    const parser = new LogParser();

    const lines = [
      {
        timestamp: '2026-07-17T19:00:00.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing options' }] },
      },
      { type: 'custom-title', customTitle: 'Auth spike' },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    expect(parser.parse(tempFilePath, 'claude-code').lastEntryIsThinking).toBe(true);
  });

  it('flags a transcript whose last turn is the user-interruption sentinel', () => {
    // Claude Code marks an Esc-interruption with no structural field at all (no stop_reason, no
    // isMeta, no origin) — the only signal is this literal text, standing alone as the whole user
    // turn. Real sample (~/.claude/projects/.../6374bbc7-....jsonl): content arrives as a single
    // text block in an array, which is what this test mirrors.
    const parser = new LogParser();

    const interrupted = {
      timestamp: '2026-08-05T22:21:54.460Z',
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(interrupted) + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');
    expect(session.lastEntryType).toBe('user');
    expect(session.lastEntryIsInterruption).toBe(true);
  });

  it('also matches the interruption sentinel when message.content is a plain string', () => {
    // The other content shape real transcripts use — must be recognized too, not just the
    // array-of-blocks form above.
    const parser = new LogParser();

    const interrupted = {
      timestamp: '2026-08-05T22:21:54.460Z',
      type: 'user',
      message: { role: 'user', content: '[Request interrupted by user]' },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(interrupted) + '\n');

    expect(parser.parse(tempFilePath, 'claude-code').lastEntryIsInterruption).toBe(true);
  });

  it('also matches the "for tool use" interruption variant', () => {
    // Second real variant confirmed on the local transcript corpus (Claude Code cancelling a
    // pending tool call specifically), at meaningful volume alongside the plain form.
    const parser = new LogParser();

    const interrupted = {
      timestamp: '2026-08-05T22:21:54.460Z',
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(interrupted) + '\n');

    expect(parser.parse(tempFilePath, 'claude-code').lastEntryIsInterruption).toBe(true);
  });

  it('clears the interruption flag once a real user turn follows it', () => {
    // The trap: a flag that only ever turns on is worse than no flag at all. If the user
    // interrupts and then types a new prompt, the session must count as awaiting a reply again.
    const parser = new LogParser();

    const interrupted = {
      timestamp: '2026-08-05T22:21:54.460Z',
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(interrupted) + '\n');
    expect(parser.parse(tempFilePath, 'claude-code').lastEntryIsInterruption).toBe(true);

    const realPrompt = {
      timestamp: '2026-08-05T22:22:10.000Z',
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Try again, but simpler' }] },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(realPrompt) + '\n');

    expect(new LogParser().parse(tempFilePath, 'claude-code').lastEntryIsInterruption).toBe(false);
  });

  it('does not flag a real user turn that merely quotes the interruption phrase', () => {
    // Exact match only, never includes() — a user can legitimately discuss this exact sentinel in
    // a real prompt, and that session genuinely is awaiting a reply.
    const parser = new LogParser();

    const line = {
      timestamp: '2026-08-05T22:21:54.460Z',
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Why does it say [Request interrupted by user] here?' }],
      },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(line) + '\n');

    expect(parser.parse(tempFilePath, 'claude-code').lastEntryIsInterruption).toBe(false);
  });

  it('does not flag a multi-block turn even when one block exactly matches the sentinel', () => {
    // A genuine interruption entry is always a single lone text block. Extra blocks mean this is
    // a real, richer turn that merely happens to contain the phrase among other content.
    const parser = new LogParser();

    const line = {
      timestamp: '2026-08-05T22:21:54.460Z',
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Request interrupted by user]' },
          { type: 'text', text: 'actually, continue' },
        ],
      },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(line) + '\n');

    expect(parser.parse(tempFilePath, 'claude-code').lastEntryIsInterruption).toBe(false);
  });

  it('does not let trailing bookkeeping entries erase an interruption signal', () => {
    // Mirrors the awaited-reply test below: attachment/last-prompt/ai-title carry no `message`,
    // so none of them may resurrect or erase lastEntryIsInterruption either.
    const parser = new LogParser();

    const lines = [
      {
        timestamp: '2026-08-05T22:21:54.460Z',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      },
      { type: 'attachment' },
      { type: 'last-prompt' },
      { type: 'ai-title', aiTitle: 'Some title' },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');
    expect(session.lastEntryType).toBe('user');
    expect(session.lastEntryIsInterruption).toBe(true);
  });

  it('does not let trailing bookkeeping entries (attachment, last-prompt, ai-title) erase an awaited-reply signal', () => {
    // Real transcripts write `attachment`/`last-prompt`/`ai-title` entries right after every turn,
    // before the next assistant turn begins — `attachment` is by far the most frequent of the
    // three. None of them carry `message`, so none may overwrite lastEntryType away from the last
    // real conversational turn: a tool_result (role 'user') means Claude still owes a reply, and
    // that must survive until the next real assistant/user turn, however many bookkeeping lines
    // land in between.
    const parser = new LogParser();

    const lines = [
      {
        timestamp: '2026-07-17T19:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      },
      { type: 'attachment' },
      { type: 'last-prompt' },
      { type: 'ai-title', aiTitle: 'Some title' },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    expect(parser.parse(tempFilePath, 'claude-code').lastEntryType).toBe('user');
  });

  it('lets a user rename win over the first prompt and over a later generated title', () => {
    // Claude Code records a rename as its own `type: 'custom-title'` entry and keeps showing that
    // name for the session. Since a generated `ai-title` can land afterwards, plain assignment
    // order would silently undo the rename — the parser latches it instead.
    const parser = new LogParser();

    const lines = [
      {
        timestamp: '2026-07-17T19:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Implement Google OAuth' }] },
      },
      { type: 'custom-title', customTitle: 'Auth spike' },
      { type: 'ai-title', aiTitle: 'Implementing OAuth login flow' },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');

    expect(session.sessionTitle).toBe('Auth spike');
    expect(session.titleIsCustom).toBe(true);
  });

  it('applies the latest rename when the session was renamed more than once', () => {
    const parser = new LogParser();

    const lines = [
      { type: 'custom-title', customTitle: 'First name' },
      { type: 'custom-title', customTitle: 'Second name' },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    expect(parser.parse(tempFilePath, 'claude-code').sessionTitle).toBe('Second name');
  });

  it('ignores a blank rename so the session keeps its derived title', () => {
    const parser = new LogParser();

    const lines = [
      {
        timestamp: '2026-07-17T19:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Implement Google OAuth' }] },
      },
      { type: 'custom-title', customTitle: '   ' },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');

    expect(session.sessionTitle).toContain('Implement Google OAuth');
    expect(session.titleIsCustom).toBeFalsy();
  });

  // Regression: Claude Code 2.1.223 auto-stamps `type:"custom-title"` to the session's own
  // worktree name every time it enters that worktree — captured verbatim from a real
  // structured-logging worktree session (paths genericized, shape and field names untouched:
  // `{"type":"worktree-state","worktreeSession":{"worktreeName":"structured-logging",...}}`
  // then later `{"type":"custom-title","customTitle":"structured-logging",...}`). Trusting the
  // second as a real rename made every session that ever entered the worktree collapse onto the
  // identical sessionTitle, so sessionDedupe.getDedupeKey() (keyed on
  // type+projectPath+gitBranch+title) silently collided them onto one slot.
  it('does not let an auto-stamped custom-title matching the worktree name override the real title', () => {
    const parser = new LogParser();

    const lines = [
      {
        timestamp: '2026-08-07T00:57:50.000Z',
        type: 'user',
        gitBranch: 'main',
        cwd: '/Users/dev/repo',
        message: { role: 'user', content: [{ type: 'text', text: 'revisar PR de logging estruturado' }] },
      },
      {
        type: 'worktree-state',
        worktreeSession: {
          originalCwd: '/Users/dev/repo',
          preEnterOriginalCwd: '/Users/dev/repo',
          worktreePath: '/Users/dev/repo/.claude/worktrees/structured-logging',
          worktreeName: 'structured-logging',
          worktreeBranch: 'feat/structured-logging',
          enteredExisting: true,
        },
      },
      { type: 'custom-title', customTitle: 'structured-logging' },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');

    expect(session.sessionTitle).toBe('revisar PR de logging estruturado');
    expect(session.titleIsCustom).toBeFalsy();
  });

  // Regression (real capture: session `7ac34ece-fdce-41ad-9898-886d832035ec` — sanity-checked
  // against the live file while assessing whether session.worktreeName's one-way latch (see
  // projectPathResolver.ts's detectWorktreeName KNOWN LIMITATION comment) could cheaply be fixed
  // to clear on exit). A clearing rule keyed on "relocated to a bare, non-worktree cwd" was tried
  // first and reverted:
  // this exact real sequence — relocate OUT to a bare cwd, a `worktree-state` entry with
  // `worktreeSession: null`, THEN THE SAME auto-stamped customTitle again — proved a session can
  // transiently leave and come back while Claude Code keeps re-stamping the identical echo. A
  // clearing rule made that second, still-bogus stamp get wrongly ACCEPTED as a real rename.
  // Pinning the correct (latch-through-transient-exit) behavior down so it can't regress back in.
  it('keeps rejecting the same repeated auto-stamp across a transient relocate-out-and-back', () => {
    const parser = new LogParser();

    const lines = [
      {
        type: 'worktree-state',
        worktreeSession: { worktreeName: 'feat/42-example-generic-feature-name' },
      },
      {
        type: 'relocated',
        relocatedCwd: '/Users/dev/repo/.claude/worktrees/feat+42-example-generic-feature-name',
      },
      { type: 'relocated', relocatedCwd: '/Users/dev/repo' }, // transient: back to the bare base repo...
      { type: 'worktree-state', worktreeSession: null }, // ...reflected here too
      // ...but Claude Code re-stamps the SAME auto-echo anyway — still not a real rename:
      { type: 'custom-title', customTitle: 'feat+42-example-generic-feature-name' },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');

    expect(session.titleIsCustom).toBeFalsy();
  });

  it('still lets a genuine user rename (different from the worktree name) win, even inside a worktree', () => {
    const parser = new LogParser();

    const lines = [
      {
        type: 'worktree-state',
        worktreeSession: { worktreeName: 'structured-logging', worktreeBranch: 'feat/structured-logging' },
      },
      { type: 'custom-title', customTitle: 'My renamed session' },
    ];
    fs.appendFileSync(tempFilePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');

    expect(session.sessionTitle).toBe('My renamed session');
    expect(session.titleIsCustom).toBe(true);
  });

  it('keeps two genuinely distinct sessions that both entered the same worktree from colliding onto one dedupe slot', () => {
    // The exact reported bug: four independent real sessions (different ids, different real
    // prompts, different days) all entered the same worktree and all got the identical
    // auto-stamped custom-title — collapsing them onto one sessionDedupe slot and silently
    // dropping every session but the isMoreRelevant winner, including the one actively running
    // subagents.
    const sessionBPath = path.join(tempDir, 'test-session-b.jsonl');
    try {
      const linesA = [
        {
          timestamp: '2026-08-07T00:57:50.000Z',
          type: 'user',
          gitBranch: 'feat/structured-logging',
          cwd: '/Users/dev/repo/.claude/worktrees/structured-logging',
          message: { role: 'user', content: [{ type: 'text', text: 'revisar PR de logging estruturado' }] },
        },
        {
          type: 'worktree-state',
          worktreeSession: { worktreeName: 'structured-logging', worktreeBranch: 'feat/structured-logging' },
        },
        { type: 'custom-title', customTitle: 'structured-logging' },
      ];
      const linesB = [
        {
          timestamp: '2026-08-05T20:23:38.000Z',
          type: 'user',
          gitBranch: 'feat/structured-logging',
          cwd: '/Users/dev/repo/.claude/worktrees/structured-logging',
          message: { role: 'user', content: [{ type: 'text', text: 'avalia como esta o sistema de logs hoje' }] },
        },
        {
          type: 'worktree-state',
          worktreeSession: { worktreeName: 'structured-logging', worktreeBranch: 'feat/structured-logging' },
        },
        { type: 'custom-title', customTitle: 'structured-logging' },
      ];
      fs.writeFileSync(tempFilePath, linesA.map((l) => JSON.stringify(l)).join('\n') + '\n');
      fs.writeFileSync(sessionBPath, linesB.map((l) => JSON.stringify(l)).join('\n') + '\n');

      const sessionA = new LogParser().parse(tempFilePath, 'claude-code');
      const sessionB = new LogParser().parse(sessionBPath, 'claude-code');

      expect(sessionA.sessionTitle).not.toBe(sessionB.sessionTitle);
      expect(getDedupeKey(sessionA)).not.toBe(getDedupeKey(sessionB));
    } finally {
      if (fs.existsSync(sessionBPath)) {
        fs.unlinkSync(sessionBPath);
      }
    }
  });
});
