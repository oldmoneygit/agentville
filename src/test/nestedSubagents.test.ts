import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { refreshNestedSubagents } from '../nestedSubagents';
import { Session, SubAgent } from '../types';

// "Grandchildren": subagents launched BY another subagent, not by the session itself. Claude
// Code writes their sidecar with parentAgentId pointing at the LAUNCHING subagent's own
// agentId. Real corpus (5007 sidecars): 136 carry parentAgentId across 26 projects; 125 also
// carry toolUseId (classic nested Agent-tool dispatch) and 11 don't (forked-skill teammates,
// see forkedSkillDetector.ts) — the grouping below must cover both, keyed only on
// parentAgentId, never taskKind/spawnDepth (spawnDepth is 1 for teammates despite being
// grandchildren, so it cannot be used to detect nesting).
//
// Mirrors the real on-disk layout: <claudeProjectsDir>/<encoded-project-dir>/<sessionId>/subagents/agent-<id>.{meta.json,jsonl}.
describe('refreshNestedSubagents', () => {
  let claudeProjectsDir: string;
  const sessionId = 'test-session-id';
  const baseDirName = '-Users-dev-Projetos-demo';
  const worktreeDirName = '-Users-dev-Projetos-demo--claude-worktrees-fix-thing';

  beforeEach(() => {
    claudeProjectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-subagents-test-'));
  });

  afterEach(() => {
    fs.rmSync(claudeProjectsDir, { recursive: true, force: true });
  });

  function subagentsDirFor(projectDirName: string): string {
    return path.join(claudeProjectsDir, projectDirName, sessionId, 'subagents');
  }

  function writeSidecar(projectDirName: string, fileId: string, meta: Record<string, unknown>): void {
    const subagentsDir = subagentsDirFor(projectDirName);
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, `agent-${fileId}.meta.json`), JSON.stringify(meta));
  }

  /** Backdates the sidecar's OWN mtime by `msAgo` — used to test the missing-.jsonl fallback
   * (computeChildStatus), which is bounded by the sidecar's own write time, not the child's. */
  function backdateSidecar(projectDirName: string, fileId: string, msAgo: number): void {
    const sidecarPath = path.join(subagentsDirFor(projectDirName), `agent-${fileId}.meta.json`);
    const mtime = new Date(Date.now() - msAgo);
    fs.utimesSync(sidecarPath, mtime, mtime);
  }

  /** Writes the sibling agent-<fileId>.jsonl a child's best-effort status is read from, backdated
   * by `msAgo` (0 = just written). */
  function writeChildTranscript(projectDirName: string, fileId: string, msAgo: number): void {
    const subagentsDir = subagentsDirFor(projectDirName);
    fs.mkdirSync(subagentsDir, { recursive: true });
    const jsonlPath = path.join(subagentsDir, `agent-${fileId}.jsonl`);
    fs.writeFileSync(jsonlPath, '{}\n');
    const mtime = new Date(Date.now() - msAgo);
    fs.utimesSync(jsonlPath, mtime, mtime);
  }

  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: sessionId,
      projectHash: 'hash',
      projectPath: '/Users/dev/Projetos/demo',
      projectName: 'demo',
      gitBranch: 'main',
      status: 'stopped',
      lastInteractionTime: Date.now(),
      subagents: [],
      logFilePath: path.join(claudeProjectsDir, baseDirName, `${sessionId}.jsonl`),
      type: 'claude-code',
      ...overrides,
    };
  }

  function makeSubagent(overrides: Partial<SubAgent> = {}): SubAgent {
    return { id: 'toolu_01ABC123', name: 'Agent', task: 'Delegate task', status: 'working', ...overrides };
  }

  it('attaches a grandchild with no toolUseId (forked-skill teammate) to the parent found by sub.agentId', () => {
    // Real teammate sidecar shape (acme-dashboard): no toolUseId, but parentAgentId + description.
    writeSidecar(baseDirName, 'child-1', {
      agentType: 'angle-a-linebyline',
      description: 'Angle A: line-by-line diff scan of new hooks',
      parentAgentId: 'parent-agent-1',
      model: 'sonnet',
    });
    writeChildTranscript(baseDirName, 'child-1', 1000);
    const parent = makeSubagent({ id: 'toolu_parent1', agentId: 'parent-agent-1', name: 'code-reviewer' });
    const session = makeSession({ subagents: [parent] });

    refreshNestedSubagents(session);

    expect(parent.children).toHaveLength(1);
    expect(parent.children?.[0]).toMatchObject({
      agentId: 'child-1',
      name: 'angle-a-linebyline',
      task: 'Angle A: line-by-line diff scan of new hooks',
      model: 'sonnet',
      status: 'working',
    });
  });

  it('attaches a grandchild WITH toolUseId (classic nested dispatch) — proves grouping is general, not teammate-only', () => {
    // Real classic-dispatch sidecar shape (northwind-app): toolUseId present alongside parentAgentId.
    writeSidecar(baseDirName, 'child-2', {
      agentType: 'Explore',
      description: 'Investigate eve event model and eval auth',
      toolUseId: 'toolu_01W3ZphRVbdxWzwzM9F6dycs',
      parentAgentId: 'parent-agent-2',
    });
    writeChildTranscript(baseDirName, 'child-2', 1000);
    const parent = makeSubagent({ id: 'toolu_parent2', agentId: 'parent-agent-2', name: 'debugger' });
    const session = makeSession({ subagents: [parent] });

    refreshNestedSubagents(session);

    expect(parent.children).toHaveLength(1);
    expect(parent.children?.[0].name).toBe('Explore');
  });

  it('attaches children to a parent identified by sub.id when sub.id === agentId (forked-skill parent)', () => {
    // forkedSkillDetector.ts creates the forked-skill SubAgent with id === agentId (no separate
    // .agentId field is ever set for it) — the join must fall back to sub.id in that case.
    writeSidecar(baseDirName, 'child-3', {
      agentType: 'angle-b-tests',
      parentAgentId: 'a2e15c98935a695a32',
    });
    writeChildTranscript(baseDirName, 'child-3', 1000);
    const parent = makeSubagent({ id: 'a2e15c98935a695a32', name: 'code-review', agentId: undefined });
    const session = makeSession({ subagents: [parent] });

    refreshNestedSubagents(session);

    expect(parent.children).toHaveLength(1);
    expect(parent.children?.[0].name).toBe('angle-b-tests');
  });

  it('ignores a sidecar whose parentAgentId matches no known subagent, without throwing or creating a phantom parent', () => {
    writeSidecar(baseDirName, 'orphan', {
      agentType: 'orphan-type',
      parentAgentId: 'no-such-parent',
    });
    writeChildTranscript(baseDirName, 'orphan', 1000);
    const parent = makeSubagent({ id: 'toolu_parent3', agentId: 'parent-agent-3' });
    const session = makeSession({ subagents: [parent] });

    expect(() => {
      refreshNestedSubagents(session);
    }).not.toThrow();
    expect(parent.children).toBeUndefined();
  });

  it('truncates depth-3 nesting: a grandchild-of-grandchild is not attached anywhere (deliberate)', () => {
    // B is A's child; C's parent is B (not A) — a real but rare depth-3 chain (5 of 5007 sidecars).
    writeSidecar(baseDirName, 'b-agent-id', { agentType: 'level-2', parentAgentId: 'a-agent-id' });
    writeChildTranscript(baseDirName, 'b-agent-id', 1000);
    writeSidecar(baseDirName, 'c-agent-id', { agentType: 'level-3', parentAgentId: 'b-agent-id' });
    writeChildTranscript(baseDirName, 'c-agent-id', 1000);
    const parentA = makeSubagent({ id: 'toolu_a', agentId: 'a-agent-id' });
    const session = makeSession({ subagents: [parentA] });

    refreshNestedSubagents(session);

    expect(parentA.children).toHaveLength(1);
    expect(parentA.children?.[0].name).toBe('level-2');
    expect(parentA.children?.[0].children).toBeUndefined();
  });

  it('drops non-string sidecar fields on a grandchild instead of rendering them as [object Object]', () => {
    writeSidecar(baseDirName, 'weirdchild', {
      agentType: { nested: 'oops' },
      description: 42,
      parentAgentId: 'parent-agent-7',
    });
    writeChildTranscript(baseDirName, 'weirdchild', 1000);
    const parent = makeSubagent({ id: 'toolu_p7', agentId: 'parent-agent-7' });
    const session = makeSession({ subagents: [parent] });

    refreshNestedSubagents(session);

    expect(parent.children).toHaveLength(1);
    expect(parent.children?.[0].name).toBe('Agent');
    expect(parent.children?.[0].task).toBe('Delegate task');
  });

  describe('grandchild status (mtime-based, best-effort)', () => {
    it('marks a grandchild working when its sidecar-sibling .jsonl was written recently', () => {
      writeSidecar(baseDirName, 'fresh', { agentType: 'x', parentAgentId: 'parent-agent-4' });
      writeChildTranscript(baseDirName, 'fresh', 1000);
      const parent = makeSubagent({ id: 'toolu_p4', agentId: 'parent-agent-4' });
      const session = makeSession({ subagents: [parent] });

      refreshNestedSubagents(session);

      expect(parent.children?.[0].status).toBe('working');
    });

    it('keeps a grandchild working when its .jsonl was written about 2 minutes ago (long write gaps are normal)', () => {
      // Regression for using RECENT_WRITE (60s) here: a real working grandchild routinely goes
      // minutes between transcript writes, same as a session does (sessionActivity.ts) — this
      // would have read 'stopped' under the old 60s threshold.
      writeSidecar(baseDirName, 'slow-writer', { agentType: 'x', parentAgentId: 'parent-agent-11' });
      writeChildTranscript(baseDirName, 'slow-writer', 2 * 60 * 1000);
      const parent = makeSubagent({ id: 'toolu_p11', agentId: 'parent-agent-11' });
      const session = makeSession({ subagents: [parent] });

      refreshNestedSubagents(session);

      expect(parent.children?.[0].status).toBe('working');
    });

    it('marks a grandchild stopped when its sidecar-sibling .jsonl was written long ago (past IDLE_CEILING)', () => {
      writeSidecar(baseDirName, 'old', { agentType: 'x', parentAgentId: 'parent-agent-5' });
      writeChildTranscript(baseDirName, 'old', 35 * 60 * 1000); // 35 minutes ago, past the 30-min ceiling
      const parent = makeSubagent({ id: 'toolu_p5', agentId: 'parent-agent-5' });
      const session = makeSession({ subagents: [parent] });

      refreshNestedSubagents(session);

      expect(parent.children?.[0].status).toBe('stopped');
    });

    it('defaults a grandchild to working when its sidecar was JUST written and its .jsonl does not exist yet', () => {
      // Sidecar written at launch time, at/before the transcript file — a missing .jsonl right
      // after a fresh sidecar most likely means "just launched", not "finished and cleaned up".
      writeSidecar(baseDirName, 'nojsonl-fresh', { agentType: 'x', parentAgentId: 'parent-agent-6' });
      const parent = makeSubagent({ id: 'toolu_p6', agentId: 'parent-agent-6' });
      const session = makeSession({ subagents: [parent] });

      refreshNestedSubagents(session);

      expect(parent.children?.[0].status).toBe('working');
    });

    it('marks a grandchild stopped when its sidecar is old and its .jsonl still does not exist (orphaned launch)', () => {
      // The child died before ever writing a transcript (API error, kill, invalid model) — an
      // orphaned sidecar must not read as 'working' forever.
      writeSidecar(baseDirName, 'nojsonl-old', { agentType: 'x', parentAgentId: 'parent-agent-10' });
      backdateSidecar(baseDirName, 'nojsonl-old', 5 * 60 * 1000);
      const parent = makeSubagent({ id: 'toolu_p10', agentId: 'parent-agent-10' });
      const session = makeSession({ subagents: [parent] });

      refreshNestedSubagents(session);

      expect(parent.children?.[0].status).toBe('stopped');
    });
  });

  describe('decoupled from the parent transcript (refreshed on its own cadence)', () => {
    it('picks up a grandchild that appears only after an earlier refresh pass', () => {
      // An unrelated sidecar is present from the start and gets cached on the first pass — this
      // proves the second pass re-reads the directory instead of trusting a stale cached listing,
      // not merely discovering a directory that didn't exist before.
      writeSidecar(baseDirName, 'unrelated', { agentType: 'unrelated', parentAgentId: 'someone-else' });
      const parent = makeSubagent({ id: 'toolu_p9', agentId: 'parent-agent-9' });
      const session = makeSession({ subagents: [parent] });

      refreshNestedSubagents(session);
      expect(parent.children).toBeUndefined();

      writeSidecar(baseDirName, 'late-child', { agentType: 'late-arriving', parentAgentId: 'parent-agent-9' });
      writeChildTranscript(baseDirName, 'late-child', 1000);
      refreshNestedSubagents(session);

      expect(parent.children).toHaveLength(1);
      expect(parent.children?.[0].name).toBe('late-arriving');
    });
  });

  describe('cross-directory dedup', () => {
    it('is deterministic when the same toolUseId exists in both candidate directories', () => {
      writeSidecar(baseDirName, 'a1', {
        agentType: 'from-base',
        toolUseId: 'toolu_dup',
        parentAgentId: 'parent-agent-12',
      });
      writeChildTranscript(baseDirName, 'a1', 1000);
      writeSidecar(worktreeDirName, 'a2', {
        agentType: 'from-worktree',
        toolUseId: 'toolu_dup',
        parentAgentId: 'parent-agent-12',
      });
      writeChildTranscript(worktreeDirName, 'a2', 1000);
      const parent = makeSubagent({ id: 'toolu_p12', agentId: 'parent-agent-12' });
      const session = makeSession({
        subagents: [parent],
        logFilePath: path.join(claudeProjectsDir, baseDirName, `${sessionId}.jsonl`),
        projectPath: '/Users/dev/Projetos/demo/.claude/worktrees/fix-thing',
      });

      refreshNestedSubagents(session);

      expect(parent.children).toHaveLength(1);
      expect(parent.children?.[0].name).toBe('from-worktree');
    });

    it('deduplicates the SAME grandchild sidecar present in both candidate directories into a single child', () => {
      // Same filename (hence same filename-derived agentId, and no toolUseId) in both dirs — the
      // teammate-shaped case, where dedup must fall back to agentId instead of toolUseId.
      writeSidecar(baseDirName, 'dup-child', { agentType: 'from-base', parentAgentId: 'parent-agent-8' });
      writeChildTranscript(baseDirName, 'dup-child', 1000);
      writeSidecar(worktreeDirName, 'dup-child', { agentType: 'from-worktree', parentAgentId: 'parent-agent-8' });
      writeChildTranscript(worktreeDirName, 'dup-child', 1000);
      const parent = makeSubagent({ id: 'toolu_p8', agentId: 'parent-agent-8' });
      const session = makeSession({
        subagents: [parent],
        logFilePath: path.join(claudeProjectsDir, baseDirName, `${sessionId}.jsonl`),
        projectPath: '/Users/dev/Projetos/demo/.claude/worktrees/fix-thing',
      });

      refreshNestedSubagents(session);

      expect(parent.children).toHaveLength(1);
      expect(parent.children?.[0].name).toBe('from-worktree');
    });
  });
});
