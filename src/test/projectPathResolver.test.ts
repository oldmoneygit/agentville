import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { ProjectPathResolver } from '../projectPathResolver';
import { Session } from '../types';

// Full-module mock (not vi.spyOn): Node's fs ESM namespace exports aren't configurable here, so
// spyOn can't redefine existsSync. Mocking the whole module is what actually works, and it's safe
// — detectProjectPath's Antigravity branches touch only fs.existsSync.
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'id',
    projectHash: 'hash',
    projectPath: '',
    projectName: '',
    gitBranch: 'main',
    status: 'working',
    lastInteractionTime: Date.now(),
    subagents: [],
    logFilePath: '/tmp/id.jsonl',
    type: 'antigravity',
    ...overrides,
  };
}

describe('ProjectPathResolver.detectProjectPath', () => {
  // Regression test for a real hang: on Windows, path.dirname('C:\\') === 'C:\\' (dirname of the
  // drive root returns itself), so the old findProjectRoot loop compared against a hardcoded '/'
  // and never reached its exit condition there — it spun forever on the synchronous extension-host
  // thread. The fix compares against path.parse(current).root instead. This suite runs on POSIX,
  // where `path` resolves to path.posix, so the literal Windows 'C:\\' case can't be reproduced
  // without mocking node's `path` module — deliberately avoided as a brittle implementation-detail
  // test. Instead, fs.existsSync is stubbed to report no marker anywhere, forcing the real walk
  // (real, untouched path.dirname/path.parse arithmetic) all the way up to the filesystem root —
  // proving the general contract the fix guarantees on any platform: the walk terminates and falls
  // back rather than hanging when it finds nothing.
  it('findProjectRoot terminates and falls back to the containing directory when no ancestor has a project marker', () => {
    const filePath = '/a/b/c/d/e/file.txt';
    const resolver = new ProjectPathResolver();
    // Only the Antigravity TargetFile branch reaches the private findProjectRoot here; Claude
    // Code sessions early-return before it, and the prose-metadata branch (Active Document /
    // Other open documents) reaches the same helper for the same reason, so this one path is
    // representative of both.
    const session = makeSession();

    resolver.detectProjectPath({ TargetFile: filePath }, session);

    expect(session.projectPath).toBe(path.dirname(filePath));
  }, 2000); // explicit timeout: a reintroduced infinite loop must fail fast, not hang CI
});
