import { describe, it, expect } from 'vitest';
import {
  normalizeForKey,
  getDedupeKey,
  isMoreRelevant,
  isAgentSession,
  findParentSession,
  sessionAsSubagent,
  applyNestedAgentLiveness,
  upsertIfMoreRelevant,
} from '../sessionDedupe';
import { Session } from '../types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-a',
    projectHash: 'hash',
    projectPath: '/Users/dev/repo',
    projectName: 'repo',
    gitBranch: 'main',
    status: 'working',
    lastInteractionTime: 1000,
    subagents: [],
    logFilePath: '/tmp/session-a.jsonl',
    type: 'claude-code',
    ...overrides,
  };
}

describe('normalizeForKey', () => {
  it('strips accents', () => {
    expect(normalizeForKey('entra na sessão não')).toBe('entra-na-sessao-nao');
  });

  it('strips emojis and symbols', () => {
    expect(normalizeForKey('🚀 deploy! (prod) #1')).toBe('deploy-prod-1');
  });

  it('collapses whitespace and casing so near-identical text still merges', () => {
    expect(normalizeForKey('  Fix   Bug  ')).toBe(normalizeForKey('fix bug'));
  });

  it('produces different keys for genuinely different text', () => {
    expect(normalizeForKey('enter the obsidian-mcp worktree')).not.toBe(normalizeForKey('review the dashboard PR'));
  });
});

describe('getDedupeKey', () => {
  it('separates two concurrent sessions on the same project+branch by title', () => {
    const a = makeSession({ id: 'a', sessionTitle: 'enter the obsidian-mcp worktree' });
    const b = makeSession({ id: 'b', sessionTitle: 'review the dashboard PR' });
    expect(getDedupeKey(a)).not.toBe(getDedupeKey(b));
  });

  it('falls back to session id when no title captured yet, so fresh sessions never collide', () => {
    const a = makeSession({ id: 'a', sessionTitle: undefined });
    const b = makeSession({ id: 'b', sessionTitle: undefined });
    expect(getDedupeKey(a)).not.toBe(getDedupeKey(b));
  });

  it('merges the same logical session (same project, branch, title) into one key', () => {
    const a = makeSession({ id: 'a', sessionTitle: 'implement OAuth' });
    const b = makeSession({ id: 'b', sessionTitle: 'implement OAuth' });
    expect(getDedupeKey(a)).toBe(getDedupeKey(b));
  });

  it('is unaffected by project path casing/trailing separators', () => {
    const a = makeSession({ projectPath: '/Users/dev/repo', sessionTitle: 'x' });
    const b = makeSession({ projectPath: '/USERS/DEV/repo', sessionTitle: 'x' });
    expect(getDedupeKey(a)).toBe(getDedupeKey(b));
  });
});

describe('isMoreRelevant', () => {
  it('prefers a working session over a stopped one', () => {
    const working = makeSession({ status: 'working' });
    const stopped = makeSession({ status: 'stopped' });
    expect(isMoreRelevant(working, stopped)).toBe(true);
    expect(isMoreRelevant(stopped, working)).toBe(false);
  });

  it('prefers the session with more active subagents', () => {
    const busy = makeSession({ subagents: [{ id: '1', name: 'x', task: 't', status: 'working' }] });
    const idle = makeSession({ subagents: [] });
    expect(isMoreRelevant(busy, idle)).toBe(true);
  });

  it('does not let a stale sibling with many FINISHED subagents mask the recent live continuation', () => {
    // Regression: two stopped same-branch sessions (a compacted predecessor + its continuation).
    // Counting total subagents let the predecessor's dozens of finished agents win the slot,
    // hiding the session the user is actually on. Only working subagents should break the tie;
    // with none, the most recent wins.
    const stalePredecessor = makeSession({
      id: 'old',
      status: 'stopped',
      lastInteractionTime: 1000,
      subagents: Array.from({ length: 20 }, (_, i) => ({
        id: `${i}`,
        name: 'x',
        task: 't',
        status: 'stopped' as const,
      })),
    });
    const liveContinuation = makeSession({
      id: 'new',
      status: 'stopped',
      lastInteractionTime: 5000,
      subagents: [{ id: 'a', name: 'x', task: 't', status: 'stopped' }],
    });
    expect(isMoreRelevant(liveContinuation, stalePredecessor)).toBe(true);
    expect(isMoreRelevant(stalePredecessor, liveContinuation)).toBe(false);
  });

  it('prefers the most recently active session as a tiebreak', () => {
    const recent = makeSession({ id: 'a', lastInteractionTime: 2000 });
    const older = makeSession({ id: 'b', lastInteractionTime: 1000 });
    expect(isMoreRelevant(recent, older)).toBe(true);
  });

  it('falls back to a stable id comparison so the winner never oscillates', () => {
    const a = makeSession({ id: 'a' });
    const b = makeSession({ id: 'b' });
    expect(isMoreRelevant(b, a)).toBe(true);
    expect(isMoreRelevant(a, b)).toBe(false);
  });
});

describe('upsertIfMoreRelevant', () => {
  // Regression: Claude Code's native worktree-entry (`type: 'relocated'` / `type:
  // 'worktree-state'` — observed live in a real northwind-app transcript during the
  // investigation session that found this bug, not preserved as a repo fixture, so they
  // won't turn up in a grep here) can leave a near-empty stub transcript (one
  // `custom-title` line, no `message`) under the BASE project dir sharing the exact same
  // session-id filename as the real, actively-growing transcript that continues under the
  // WORKTREE's own project dir (confirmed against a real capture: a 138-byte stub vs. a
  // 4.25 MB live session, same id, genuinely different logFilePath). sessionTreeDataProvider's
  // session Map is keyed by that bare id, and scanning both files with a blind
  // `map.set(id, session)` let whichever file the scanner reached LAST win — an order that
  // depends on fs.readdirSync, not relevance. At the moment this collision happens
  // (mid-scan, before computeSessionStatus runs) both sessions are still 'stopped' and
  // neither has working subagents yet, so lastInteractionTime is what must decide it —
  // exactly the tie-break isMoreRelevant already has.
  it('keeps the real session over a same-id stub regardless of scan order', () => {
    const stub = makeSession({
      id: 'dup',
      status: 'stopped',
      subagents: [],
      lastInteractionTime: 1000,
      logFilePath: '/base/dup.jsonl',
    });
    const real = makeSession({
      id: 'dup',
      status: 'stopped',
      subagents: [],
      lastInteractionTime: 9000,
      logFilePath: '/base/.claude/worktrees/x/dup.jsonl',
    });

    const stubScannedFirst = new Map<string, Session>();
    upsertIfMoreRelevant(stubScannedFirst, stub.id, stub);
    upsertIfMoreRelevant(stubScannedFirst, real.id, real);
    expect(stubScannedFirst.get('dup')).toBe(real);

    const realScannedFirst = new Map<string, Session>();
    upsertIfMoreRelevant(realScannedFirst, real.id, real);
    upsertIfMoreRelevant(realScannedFirst, stub.id, stub);
    expect(realScannedFirst.get('dup')).toBe(real);
  });

  it('inserts into an empty slot unconditionally', () => {
    const map = new Map<string, Session>();
    const session = makeSession({ id: 'fresh' });
    upsertIfMoreRelevant(map, session.id, session);
    expect(map.get('fresh')).toBe(session);
  });

  // HIGH (code-reviewer): isMoreRelevant's final `a.id > b.id` tiebreak is a no-op inside
  // upsertIfMoreRelevant specifically, because every entry in this map is stored under its
  // own id — so existing.id === key === candidate.id on every real call, and `x > x` is
  // always false. When the first three criteria (status, working-subagent count,
  // lastInteractionTime) also tie — plausible when a worktree stub and its real transcript
  // are written within the same mtime tick, especially on filesystems with coarse mtime
  // granularity — isMoreRelevant returns false in BOTH directions, and without a further
  // tiebreak whichever was scanned first silently wins again: the exact bug this function
  // exists to eliminate. logFilePath always differs between the two files in the real
  // collision (confirmed: stub vs. worktree transcript are never the same file), so it's a
  // safe deterministic tiebreak that doesn't depend on scan order.
  it('breaks a genuine tie (same status, working-count, lastInteractionTime) by logFilePath, not scan order', () => {
    const stub = makeSession({
      id: 'dup',
      status: 'stopped',
      subagents: [],
      lastInteractionTime: 5000,
      logFilePath: '/aaa/stub.jsonl',
    });
    const real = makeSession({
      id: 'dup',
      status: 'stopped',
      subagents: [],
      lastInteractionTime: 5000,
      logFilePath: '/zzz/real.jsonl',
    });

    const stubFirst = new Map<string, Session>();
    upsertIfMoreRelevant(stubFirst, stub.id, stub);
    upsertIfMoreRelevant(stubFirst, real.id, real);
    expect(stubFirst.get('dup')).toBe(real);

    const realFirst = new Map<string, Session>();
    upsertIfMoreRelevant(realFirst, real.id, real);
    upsertIfMoreRelevant(realFirst, stub.id, stub);
    expect(realFirst.get('dup')).toBe(real);
  });

  // MEDIUM (typescript-reviewer): a freshly (re)parsed Session always starts 'stopped' with
  // no subagents (logParser.ts's createEmptySession default) — computeSessionStatus only
  // classifies it afterward. logParser.ts's shrink/rebuild path (file truncated then
  // rewritten, e.g. after /clear or compaction) hands back a brand-new Session object for a
  // file it just re-read from scratch. That candidate isn't a rival in a cross-file id
  // collision — it's strictly newer data for the exact same session — but by
  // isMoreRelevant's own criteria it can look "less relevant" than a stale cached object
  // still 'working' from before the rebuild. Before this function existed, the unconditional
  // `.set()` always let the latest parse of a file win; upsertIfMoreRelevant must preserve
  // that for a same-file reparse (same logFilePath) and reserve its relevance comparison for
  // genuinely different files.
  it('replaces a stale cached entry unconditionally when the candidate is a fresh reparse of the same file', () => {
    const sharedPath = '/proj/session.jsonl';
    const stale = makeSession({
      id: 'dup',
      status: 'working',
      logFilePath: sharedPath,
      lastInteractionTime: 9000,
      subagents: [{ id: 'a', name: 'x', task: 't', status: 'working' }],
    });
    const freshReparse = makeSession({
      id: 'dup',
      status: 'stopped',
      logFilePath: sharedPath,
      lastInteractionTime: 1000,
      subagents: [],
    });

    const map = new Map<string, Session>([['dup', stale]]);
    upsertIfMoreRelevant(map, freshReparse.id, freshReparse);

    expect(map.get('dup')).toBe(freshReparse);
  });
});

describe('isAgentSession', () => {
  it('flags sdk-launched sessions and spares human ones', () => {
    expect(isAgentSession(makeSession({ entrypoint: 'sdk-py' }))).toBe(true);
    expect(isAgentSession(makeSession({ entrypoint: 'sdk' }))).toBe(true);
    expect(isAgentSession(makeSession({ entrypoint: 'claude-vscode' }))).toBe(false);
    expect(isAgentSession(makeSession({ entrypoint: undefined }))).toBe(false);
  });
});

describe('findParentSession', () => {
  const agent = makeSession({
    id: 'agent',
    entrypoint: 'sdk-py',
    gitBranch: 'vault-pipeline-v2',
    projectPath: '/Users/dev/repo',
    lastInteractionTime: 10_000,
    model: 'claude-opus-4-7',
    sessionTitle: 'Review for security',
  });

  it('nests under the human session on the same project + branch within the time window', () => {
    const parent = makeSession({
      id: 'human',
      entrypoint: 'claude-vscode',
      gitBranch: 'vault-pipeline-v2',
      lastInteractionTime: 10_000 + 60_000, // 1 min apart
      status: 'stopped',
    });
    expect(findParentSession(agent, [parent])?.id).toBe('human');
  });

  it('does not match a different branch', () => {
    const other = makeSession({ id: 'human', entrypoint: 'claude-vscode', gitBranch: 'main' });
    expect(findParentSession(agent, [other])).toBeNull();
  });

  it('does not match a stopped human outside the window', () => {
    const stale = makeSession({
      id: 'human',
      entrypoint: 'claude-vscode',
      gitBranch: 'vault-pipeline-v2',
      status: 'stopped',
      lastInteractionTime: 10_000 + 60 * 60 * 1000, // 1h apart
    });
    expect(findParentSession(agent, [stale])).toBeNull();
  });

  it('still matches a working human even when far outside the window', () => {
    const working = makeSession({
      id: 'human',
      entrypoint: 'claude-vscode',
      gitBranch: 'vault-pipeline-v2',
      status: 'working',
      lastInteractionTime: 10_000 + 60 * 60 * 1000,
    });
    expect(findParentSession(agent, [working])?.id).toBe('human');
  });

  it('picks the most relevant human when several match', () => {
    const idle = makeSession({
      id: 'idle',
      entrypoint: 'claude-vscode',
      gitBranch: 'vault-pipeline-v2',
      status: 'stopped',
      lastInteractionTime: 10_000,
    });
    const active = makeSession({
      id: 'active',
      entrypoint: 'claude-vscode',
      gitBranch: 'vault-pipeline-v2',
      status: 'working',
      lastInteractionTime: 10_000,
    });
    expect(findParentSession(agent, [idle, active])?.id).toBe('active');
  });
});

describe('sessionAsSubagent', () => {
  it('carries the agent session status and its own model, and puts the session title in task, not name', () => {
    const agent = makeSession({
      id: 'agent',
      status: 'working',
      model: 'claude-opus-4-7',
      sessionTitle: 'Review for security',
    });
    const sub = sessionAsSubagent(agent);
    expect(sub).toMatchObject({
      id: 'agent',
      status: 'working',
      model: 'claude-opus-4-7',
      name: 'Agent',
      task: 'Review for security',
    });
  });

  // Regression: a background-agent session has no field distinct from its own derived title, so
  // reusing sessionTitle for `name` too made the tree row's bold label repeat its own description
  // verbatim (e.g. "Review dependency and configuration updates for security" as both). name must
  // always be the generic placeholder here, regardless of whether a title was captured.
  it('never uses the session title as name, even when one is captured', () => {
    const agent = makeSession({ id: 'agent', sessionTitle: 'Review dependency updates for security' });
    const sub = sessionAsSubagent(agent);
    expect(sub.name).toBe('Agent');
    expect(sub.name).not.toBe(sub.task);
  });

  it('falls back to the session id for task when no title was captured yet', () => {
    const agent = makeSession({ id: 'agent-untitled', sessionTitle: '' });
    const sub = sessionAsSubagent(agent);
    expect(sub.name).toBe('Agent');
    expect(sub.task).toBe('agent-untitled');
  });
});

describe('applyNestedAgentLiveness', () => {
  // computeSessionStatus only sees same-file subagents (session.subagents); a background agent
  // in its own transcript is invisible to it. Without this, a launcher session can render
  // 'stopped' while its own "Working Agents" group (fed from the separate nestedAgents match)
  // shows that same agent still working — a visibly contradictory tree row.
  it('promotes a stopped parent to working when its matched background agent is still working', () => {
    const parent = makeSession({ id: 'parent', status: 'stopped', entrypoint: 'claude-vscode' });
    const agent = makeSession({
      id: 'agent',
      status: 'working',
      entrypoint: 'sdk-py',
      projectPath: parent.projectPath,
      gitBranch: parent.gitBranch,
      lastInteractionTime: parent.lastInteractionTime,
    });

    applyNestedAgentLiveness([parent, agent]);

    expect(parent.status).toBe('working');
  });

  it('leaves the parent stopped when its matched agent already finished', () => {
    const parent = makeSession({ id: 'parent', status: 'stopped', entrypoint: 'claude-vscode' });
    const agent = makeSession({
      id: 'agent',
      status: 'stopped',
      entrypoint: 'sdk-py',
      projectPath: parent.projectPath,
      gitBranch: parent.gitBranch,
      lastInteractionTime: parent.lastInteractionTime,
    });

    applyNestedAgentLiveness([parent, agent]);

    expect(parent.status).toBe('stopped');
  });

  it('does not let a sidechain pseudo-session steal the parent promotion from the real human session', () => {
    // Regression: subagent transcripts share the parent's entrypoint ('claude-vscode'), so
    // isAgentSession alone doesn't filter them out of the candidate-parent list. A sidechain
    // pseudo-session that out-ranks the real human via isMoreRelevant (e.g. more recent
    // lastInteractionTime) could get chosen as the working agent's "parent" instead.
    const human = makeSession({
      id: 'human',
      status: 'stopped',
      entrypoint: 'claude-vscode',
      lastInteractionTime: 10_000,
    });
    const sidechain = makeSession({
      id: 'sidechain',
      status: 'stopped',
      entrypoint: 'claude-vscode',
      isSidechain: true,
      lastInteractionTime: 20_000, // more recent than human -> would out-rank it via isMoreRelevant
    });
    const agent = makeSession({
      id: 'agent',
      status: 'working',
      entrypoint: 'sdk-py',
      projectPath: human.projectPath,
      gitBranch: human.gitBranch,
      lastInteractionTime: 10_000,
    });

    applyNestedAgentLiveness([human, sidechain, agent]);

    expect(human.status).toBe('working');
    expect(sidechain.status).toBe('stopped');
  });
});
