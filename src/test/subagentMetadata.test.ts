import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { enrichSubagentMetadata } from '../subagentMetadata';
import { refreshNestedSubagents } from '../nestedSubagents';
import { Session, SubAgent } from '../types';

// Mirrors the real on-disk layout: <claudeProjectsDir>/<encoded-project-dir>/<sessionId>/subagents/agent-<id>.meta.json.
// Encoding verified against real ~/.claude/projects directory names (see subagentMetadata.ts comment).
describe('enrichSubagentMetadata', () => {
  let claudeProjectsDir: string;
  const sessionId = 'test-session-id';
  const baseDirName = '-Users-dev-Projetos-demo';
  const worktreeDirName = '-Users-dev-Projetos-demo--claude-worktrees-fix-thing';

  beforeEach(() => {
    claudeProjectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-metadata-test-'));
  });

  afterEach(() => {
    fs.rmSync(claudeProjectsDir, { recursive: true, force: true });
  });

  function writeSidecar(projectDirName: string, fileId: string, meta: Record<string, unknown>): void {
    const subagentsDir = path.join(claudeProjectsDir, projectDirName, sessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, `agent-${fileId}.meta.json`), JSON.stringify(meta));
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

  it('enriches name and model from a sidecar matched by toolUseId', () => {
    // Filename id deliberately differs from toolUseId (matches real sidecars: agent-<internal-id>.meta.json
    // whose CONTENT carries a different toolUseId) — proves the join is on file content, not filename.
    writeSidecar(baseDirName, 'internal-xyz', {
      agentType: 'explorer-agent',
      toolUseId: 'toolu_01ABC123',
      model: 'haiku',
    });
    const sub = makeSubagent();
    const session = makeSession({ subagents: [sub] });

    enrichSubagentMetadata(session);

    expect(sub.name).toBe('explorer-agent');
    expect(sub.model).toBe('haiku');
  });

  it('leaves a subagent untouched when no sidecar exists', () => {
    const sub = makeSubagent();
    const session = makeSession({ subagents: [sub] });

    enrichSubagentMetadata(session);

    expect(sub.name).toBe('Agent');
    expect(sub.model).toBeUndefined();
  });

  it('does not throw and leaves the subagent untouched on a corrupt/invalid JSON sidecar', () => {
    const subagentsDir = path.join(claudeProjectsDir, baseDirName, sessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, 'agent-broken.meta.json'), '{ not valid json !!');
    const sub = makeSubagent();
    const session = makeSession({ subagents: [sub] });

    expect(() => {
      enrichSubagentMetadata(session);
    }).not.toThrow();
    expect(sub.name).toBe('Agent');
    expect(sub.model).toBeUndefined();
  });

  it('ignores sidecar fields that are not strings', () => {
    // Valid JSON, wrong field types. A truthy non-string agentType would otherwise reach the tree
    // item label and render as "[object Object]"; the format is undocumented, so types are checked.
    writeSidecar(baseDirName, 'weird', {
      agentType: { nested: 'oops' },
      toolUseId: 'toolu_01ABC123',
      model: 42,
    });
    const sub = makeSubagent();
    const session = makeSession({ subagents: [sub] });

    enrichSubagentMetadata(session);

    expect(sub.name).toBe('Agent');
    expect(sub.model).toBeUndefined();
  });

  it('finds sidecars in the worktree-derived directory when the transcript lives in the base project directory', () => {
    // The main transcript's own directory (from logFilePath) never gets a sidecar here — only the
    // directory session.projectPath encodes to (the worktree cwd) does. Reproduces the real bug case.
    writeSidecar(worktreeDirName, 'a1', {
      agentType: 'backend-specialist',
      toolUseId: 'toolu_worktree1',
      model: 'sonnet',
    });
    const sub = makeSubagent({ id: 'toolu_worktree1' });
    const session = makeSession({
      subagents: [sub],
      logFilePath: path.join(claudeProjectsDir, baseDirName, `${sessionId}.jsonl`),
      projectPath: '/Users/dev/Projetos/demo/.claude/worktrees/fix-thing',
    });

    enrichSubagentMetadata(session);

    expect(sub.name).toBe('backend-specialist');
    expect(sub.model).toBe('sonnet');
  });

  it('is deterministic when the same toolUseId exists in both candidate directories', () => {
    writeSidecar(baseDirName, 'a1', { agentType: 'from-base', toolUseId: 'toolu_dup', model: 'opus' });
    writeSidecar(worktreeDirName, 'a2', { agentType: 'from-worktree', toolUseId: 'toolu_dup', model: 'haiku' });
    const sub = makeSubagent({ id: 'toolu_dup' });
    const session = makeSession({
      subagents: [sub],
      logFilePath: path.join(claudeProjectsDir, baseDirName, `${sessionId}.jsonl`),
      projectPath: '/Users/dev/Projetos/demo/.claude/worktrees/fix-thing',
    });

    // Run twice to prove the result doesn't flip between runs (e.g. due to fs.readdir ordering).
    enrichSubagentMetadata(session);
    const firstName = sub.name;
    const firstModel = sub.model;
    sub.name = 'Agent';
    sub.model = undefined;
    enrichSubagentMetadata(session);

    expect(sub.name).toBe(firstName);
    expect(sub.model).toBe(firstModel);
    expect(sub.name).toBe('from-worktree');
  });

  it('finds the sidecar by launchId after a SendMessage resume re-keys id away from the original launch (regression)', () => {
    // Real incident sidecar (ae9f0a218b203f23b): toolUseId is fixed at launch time forever, even
    // though detectSendMessageResume (subagentDetector.ts) re-keys the live SubAgent.id to a
    // SendMessage's own tool_use id on resume. Without falling back to launchId here, this join
    // silently stops matching and the resumed subagent never gets its real name/model.
    writeSidecar(baseDirName, 'ae9f0a218b203f23b', {
      agentType: 'debugger',
      toolUseId: 'toolu_01F4PiHD54diBzmpQMR5mx1u',
      model: 'sonnet',
    });
    const sub = makeSubagent({ id: 'toolu_01NGEeLuP4PNUqypNCbzSJr3', launchId: 'toolu_01F4PiHD54diBzmpQMR5mx1u' });
    const session = makeSession({ subagents: [sub] });

    enrichSubagentMetadata(session);

    expect(sub.name).toBe('debugger');
    expect(sub.model).toBe('sonnet');
  });

  it('reads agentId from the sidecar filename regardless of name/model enrichment', () => {
    // Real sidecar from the same incident session: agent-ad2d7960e4bd708a3a.meta.json.
    writeSidecar(baseDirName, 'ad2d7960e4bd708a3a', {
      agentType: 'implementation-reviewer',
      toolUseId: 'toolu_01XqXMspGQaPzA2Be92JahcY',
      model: 'sonnet',
    });
    const sub = makeSubagent({ id: 'toolu_01XqXMspGQaPzA2Be92JahcY' });
    const session = makeSession({ subagents: [sub] });

    enrichSubagentMetadata(session);

    expect(sub.agentId).toBe('ad2d7960e4bd708a3a');
  });

  // Real bug (northwind-app session cedc87e2): classic-dispatch launches almost always carry an
  // explicit name+model already (measured 113/113 across 3 real sessions) — so the OLD
  // needsEnrichment (name==='Agent' || !model) never even looked at the sidecar for them, and
  // agentId — the identity nestedSubagents.ts's attachNestedSubagents joins grandchildren on —
  // never got filled. Every fixture above defaults to name:'Agent', which is exactly why 153
  // passing tests didn't catch this: none of them modeled a subagent already fully named at launch.
  describe('agentId identity join (subagent already named+modeled at launch)', () => {
    it('fills agentId from the sidecar even though name and model already came from the launch', () => {
      // Real shape from the incident session: tool_use id, sidecar filename id, and the
      // toolUseId inside the sidecar content are three different strings.
      writeSidecar(baseDirName, 'a78c4c6e2dedda529', {
        agentType: 'step21',
        toolUseId: 'toolu_019pTr8gjEmq4iynxWiapJU2',
        model: 'haiku',
      });
      const sub = makeSubagent({ id: 'toolu_019pTr8gjEmq4iynxWiapJU2', name: 'step21', model: 'haiku' });
      const session = makeSession({ subagents: [sub] });

      enrichSubagentMetadata(session);

      expect(sub.agentId).toBe('a78c4c6e2dedda529');
      expect(sub.name).toBe('step21'); // launch-provided name untouched, not overwritten
      expect(sub.model).toBe('haiku'); // launch-provided model untouched
    });

    it('lets a grandchild attach to that same parent once its agentId is filled (reproduces the northwind-app case)', () => {
      writeSidecar(baseDirName, 'a78c4c6e2dedda529', {
        agentType: 'step21',
        toolUseId: 'toolu_019pTr8gjEmq4iynxWiapJU2',
        model: 'haiku',
      });
      writeSidecar(baseDirName, 'child-of-step21', {
        agentType: 'general-purpose',
        parentAgentId: 'a78c4c6e2dedda529',
        toolUseId: 'toolu_child_of_step21',
      });
      const sub = makeSubagent({ id: 'toolu_019pTr8gjEmq4iynxWiapJU2', name: 'step21', model: 'haiku' });
      const session = makeSession({ subagents: [sub] });

      enrichSubagentMetadata(session);
      refreshNestedSubagents(session);

      expect(sub.agentId).toBe('a78c4c6e2dedda529');
      expect(sub.children).toHaveLength(1);
      expect(sub.children?.[0].name).toBe('general-purpose');
    });

    it('leaves a forked-skill-shaped subagent (id already === agentId, no toolUseId sidecar) unaffected — regression', () => {
      // detectForkedSkillLaunch sets id === agentId directly at detection time, with no model —
      // so it was ALREADY a candidate via the pre-existing `!sub.model` check; the new
      // `!sub.agentId` criterion changes nothing for it, since agentId is already truthy.
      const sub = makeSubagent({
        id: 'a2e15c98935a695a32',
        agentId: 'a2e15c98935a695a32',
        name: 'code-review',
        model: undefined,
      });
      const session = makeSession({ subagents: [sub] });

      expect(() => {
        enrichSubagentMetadata(session);
      }).not.toThrow();
      expect(sub.agentId).toBe('a2e15c98935a695a32');
      expect(sub.name).toBe('code-review');
    });

    it('leaves agentId unset for an already-named subagent with no matching sidecar, without throwing, across repeated calls', () => {
      const sub = makeSubagent({ id: 'toolu_no_sidecar', name: 'already-named', model: 'sonnet' });
      const session = makeSession({ subagents: [sub] });

      expect(() => {
        enrichSubagentMetadata(session);
        enrichSubagentMetadata(session);
        enrichSubagentMetadata(session);
      }).not.toThrow();
      expect(sub.agentId).toBeUndefined();
      expect(sub.name).toBe('already-named');
      expect(sub.model).toBe('sonnet');
    });
  });
});
