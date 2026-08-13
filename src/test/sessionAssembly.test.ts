import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { assembleVisibleSessions } from '../sessionAssembly';
import { Session } from '../types';

const NOW = 1_000_000_000_000;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'id',
    projectHash: 'hash',
    projectPath: '/Users/dev/repo',
    projectName: 'repo',
    gitBranch: 'main',
    status: 'working',
    lastInteractionTime: NOW,
    subagents: [],
    logFilePath: '/tmp/id.jsonl',
    type: 'claude-code',
    ...overrides,
  };
}

describe('assembleVisibleSessions', () => {
  it('keeps two concurrent same-branch sessions with distinct titles (the "only one shows" fix)', () => {
    const a = makeSession({ id: 'a', gitBranch: 'feat/x', projectPath: '/repo/wt/x', sessionTitle: 'first task' });
    const b = makeSession({ id: 'b', gitBranch: 'feat/x', projectPath: '/repo/wt/x', sessionTitle: 'second task' });
    const { topLevel } = assembleVisibleSessions([a, b], [], NOW);
    expect(topLevel).toHaveLength(2);
  });

  it('collapses two same-branch sessions that share a title into one slot', () => {
    // Two distinct logFilePaths: this models two genuinely different session files (e.g. two
    // Claude Code windows on the same repo) colliding on dedupe key, not a same-file reparse —
    // upsertIfMoreRelevant only skips the relevance check when logFilePath actually matches.
    const a = makeSession({
      id: 'a',
      gitBranch: 'feat/x',
      projectPath: '/repo/wt/x',
      sessionTitle: 'same title',
      subagents: [],
      logFilePath: '/tmp/a.jsonl',
    });
    const b = makeSession({
      id: 'b',
      gitBranch: 'feat/x',
      projectPath: '/repo/wt/x',
      sessionTitle: 'same title',
      status: 'stopped',
      logFilePath: '/tmp/b.jsonl',
    });
    const { topLevel } = assembleVisibleSessions([a, b], [], NOW);
    expect(topLevel).toHaveLength(1);
    expect(topLevel[0].id).toBe('a'); // the working one wins
  });

  it('excludes subagent sidechains', () => {
    const s = makeSession({ isSidechain: true });
    expect(assembleVisibleSessions([s], [], NOW).topLevel).toHaveLength(0);
  });

  it('ages out a stopped session older than an hour but keeps a running one', () => {
    const oldStopped = makeSession({ id: 'old', status: 'stopped', lastInteractionTime: NOW - 61 * 60 * 1000 });
    const oldRunning = makeSession({
      id: 'run',
      gitBranch: 'other',
      status: 'working',
      lastInteractionTime: NOW - 61 * 60 * 1000,
    });
    const { topLevel } = assembleVisibleSessions([oldStopped, oldRunning], [], NOW);
    expect(topLevel.map((s) => s.id)).toEqual(['run']);
  });

  it('scopes Claude Code sessions to the active workspace folders', () => {
    const inside = makeSession({ id: 'in', projectPath: '/Users/dev/repo/wt/a', gitBranch: 'a' });
    const outside = makeSession({ id: 'out', projectPath: '/Users/dev/other', gitBranch: 'b' });
    // sessionTreeDataProvider.ts always normalizes+lowercases activePaths before calling in;
    // mirror that here instead of a raw literal, or this assertion silently breaks on Windows
    // (path.normalize turns '/' into '\' there, so an un-normalized literal never matches again).
    const activePath = path.normalize('/Users/dev/repo').toLowerCase();
    const { topLevel } = assembleVisibleSessions([inside, outside], [activePath], NOW);
    expect(topLevel.map((s) => s.id)).toEqual(['in']);
  });

  it('nests an SDK-spawned agent under its human launcher instead of showing it top-level', () => {
    const human = makeSession({
      id: 'human',
      gitBranch: 'feat/y',
      projectPath: '/repo/wt/y',
      entrypoint: 'claude-vscode',
    });
    const agent = makeSession({
      id: 'agent',
      gitBranch: 'feat/y',
      projectPath: '/repo/wt/y',
      entrypoint: 'sdk-py',
      sessionTitle: 'security review',
    });
    const { topLevel, nestedAgents } = assembleVisibleSessions([human, agent], [], NOW);
    expect(topLevel.map((s) => s.id)).toEqual(['human']);
    expect(nestedAgents.get('human')?.map((a) => a.id)).toEqual(['agent']);
  });

  it('orders a less-recent working session before a more-recent stopped session', () => {
    const stoppedRecent = makeSession({
      id: 'stopped-recent',
      status: 'stopped',
      lastInteractionTime: NOW - 5 * 60 * 1000,
    });
    const workingOld = makeSession({ id: 'working-old', status: 'working', lastInteractionTime: NOW - 20 * 60 * 1000 });
    // Input order deliberately puts the more-recent stopped session first, so the assertion
    // only passes if working-first grouping actually reorders it (not by accident of input order).
    const { topLevel } = assembleVisibleSessions([stoppedRecent, workingOld], [], NOW);
    expect(topLevel.map((s) => s.id)).toEqual(['working-old', 'stopped-recent']);
  });

  it('keeps most-recent-first within the same status group', () => {
    const olderWorking = makeSession({ id: 'w-older', status: 'working', lastInteractionTime: NOW - 10 * 60 * 1000 });
    const recentWorking = makeSession({ id: 'w-recent', status: 'working', lastInteractionTime: NOW - 1 * 60 * 1000 });
    const { topLevel } = assembleVisibleSessions([olderWorking, recentWorking], [], NOW);
    expect(topLevel.map((s) => s.id)).toEqual(['w-recent', 'w-older']);
  });
});
