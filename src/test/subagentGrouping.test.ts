import { describe, it, expect } from 'vitest';
import { splitSubagentsByStatus } from '../subagentGrouping';
import { Session, SubAgent } from '../types';

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

function makeSubAgent(overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    id: 'sub-1',
    name: 'Agent',
    task: 'do work',
    status: 'working',
    ...overrides,
  };
}

describe('splitSubagentsByStatus', () => {
  // Regression: a subagent that is genuinely still 'working' must never be reclassified as
  // completed just because its PARENT session's own status currently reads 'stopped' — a session
  // can go idle between transcript writes (sessionActivity.ts's computeSessionStatus can miss a
  // long gap between a subagent's launch and its completion) while a subagent it dispatched
  // keeps running. Before this fix, sessionTreeDataProvider.ts's getChildren() gated the
  // session's OWN subagents on `session.status === 'working'`, silently dumping every one of
  // them into "Completed Agents" the moment the parent read 'stopped' — even a subagent whose own
  // tracked status was still 'working'.
  it('keeps a working subagent under "working" even when the parent session itself reads stopped', () => {
    const session = makeSession({ status: 'stopped', subagents: [makeSubAgent({ id: '1', status: 'working' })] });

    const { working, completed } = splitSubagentsByStatus(session, []);

    expect(working.map((s) => s.id)).toEqual(['1']);
    expect(completed).toEqual([]);
  });

  it('puts a stopped subagent under completed regardless of the parent session status', () => {
    const session = makeSession({ status: 'working', subagents: [makeSubAgent({ id: '1', status: 'stopped' })] });

    const { working, completed } = splitSubagentsByStatus(session, []);

    expect(working).toEqual([]);
    expect(completed.map((s) => s.id)).toEqual(['1']);
  });

  it('merges nested (cross-file background-agent) subagents into the same groups by their own status', () => {
    const session = makeSession({ status: 'working', subagents: [] });
    const nested = [makeSubAgent({ id: 'n1', status: 'working' }), makeSubAgent({ id: 'n2', status: 'stopped' })];

    const { working, completed } = splitSubagentsByStatus(session, nested);

    expect(working.map((s) => s.id)).toEqual(['n1']);
    expect(completed.map((s) => s.id)).toEqual(['n2']);
  });

  it("splits a mix of own and nested subagents purely by each one's own status", () => {
    const session = makeSession({
      status: 'stopped',
      subagents: [
        makeSubAgent({ id: 'own-working', status: 'working' }),
        makeSubAgent({ id: 'own-done', status: 'stopped' }),
      ],
    });
    const nested = [
      makeSubAgent({ id: 'nested-working', status: 'working' }),
      makeSubAgent({ id: 'nested-done', status: 'stopped' }),
    ];

    const { working, completed } = splitSubagentsByStatus(session, nested);

    expect(working.map((s) => s.id).sort()).toEqual(['nested-working', 'own-working']);
    expect(completed.map((s) => s.id).sort()).toEqual(['nested-done', 'own-done']);
  });
});
