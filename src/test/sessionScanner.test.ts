import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanSessionFiles, LogFileRef } from '../sessionScanner';

// Real-tmpdir pattern (mirrors subagentMetadata.test.ts / logParser.projectPath.test.ts):
// sessionScanner is fundamentally about directory traversal, so these tests build real
// directory trees under a per-test tmp root instead of mocking `fs`.
describe('scanSessionFiles', () => {
  let testRoot: string;
  let claudeProjectsPath: string;
  let geminiBrainPath: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-scanner-test-'));
    // Neither directory is created here on purpose: tests that need them to exist create them
    // explicitly, so the "nonexistent path" cases need no extra setup at all.
    claudeProjectsPath = path.join(testRoot, 'claude-projects');
    geminiBrainPath = path.join(testRoot, 'gemini-brain');
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function writeClaudeRootFile(projectDirName: string, fileName: string): string {
    const projectDir = path.join(claudeProjectsPath, projectDirName);
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, fileName);
    fs.writeFileSync(filePath, '');
    return filePath;
  }

  function writeClaudeSubSessionFile(projectDirName: string, fileName: string): string {
    const sessionsDir = path.join(claudeProjectsPath, projectDirName, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, fileName);
    fs.writeFileSync(filePath, '');
    return filePath;
  }

  function writeGeminiTranscript(convDirName: string): string {
    const logsDir = path.join(geminiBrainPath, convDirName, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, 'transcript.jsonl');
    fs.writeFileSync(filePath, '');
    return filePath;
  }

  describe('missing or empty roots', () => {
    it('returns an empty array and does not throw when both paths are nonexistent', () => {
      let result: LogFileRef[] = [];

      expect(() => {
        result = scanSessionFiles(claudeProjectsPath, geminiBrainPath);
      }).not.toThrow();
      expect(result).toEqual([]);
    });

    it('returns an empty array when claudeProjectsPath exists but has no project directories', () => {
      fs.mkdirSync(claudeProjectsPath);

      const result = scanSessionFiles(claudeProjectsPath, geminiBrainPath);

      expect(result).toEqual([]);
    });
  });

  describe('Claude Code discovery', () => {
    it('discovers root-level .jsonl files and ignores non-.jsonl entries in the same directory', () => {
      const jsonlPath = writeClaudeRootFile('project-a', 'session1.jsonl');
      fs.writeFileSync(path.join(claudeProjectsPath, 'project-a', 'notes.json'), '');
      fs.writeFileSync(path.join(claudeProjectsPath, 'project-a', 'readme.txt'), '');
      fs.mkdirSync(path.join(claudeProjectsPath, 'project-a', 'stray-dir'));

      const result = scanSessionFiles(claudeProjectsPath, geminiBrainPath);

      expect(result).toEqual([{ path: jsonlPath, type: 'claude-code' }]);
    });

    it('aggregates root-level .jsonl files across multiple project directories', () => {
      const fileA = writeClaudeRootFile('project-a', 'a.jsonl');
      const fileB = writeClaudeRootFile('project-b', 'b.jsonl');
      const fileC = writeClaudeRootFile('project-c', 'c.jsonl');

      const result = scanSessionFiles(claudeProjectsPath, geminiBrainPath);

      expect(result).toEqual(
        expect.arrayContaining([
          { path: fileA, type: 'claude-code' },
          { path: fileB, type: 'claude-code' },
          { path: fileC, type: 'claude-code' },
        ]),
      );
      expect(result).toHaveLength(3);
    });

    // <project>/sessions/*.jsonl does not exist in any real Claude Code install (see
    // .claude/memory/reference-transcript-subagent-layout.md — real subagent transcripts live at
    // <project>/<session-id>/subagents/*.jsonl instead). This is dead code today; these two tests
    // document its actual contract as written rather than assume it, without changing it.
    it('scans <project>/sessions/*.jsonl when that directory happens to exist, ignoring non-.jsonl entries in it', () => {
      const rootFile = writeClaudeRootFile('project-a', 'main.jsonl');
      const subFile = writeClaudeSubSessionFile('project-a', 'nested.jsonl');
      fs.writeFileSync(path.join(claudeProjectsPath, 'project-a', 'sessions', 'notes.json'), '');

      const result = scanSessionFiles(claudeProjectsPath, geminiBrainPath);

      expect(result).toEqual(
        expect.arrayContaining([
          { path: rootFile, type: 'claude-code' },
          { path: subFile, type: 'claude-code' },
        ]),
      );
      expect(result).toHaveLength(2);
    });

    it('finds nothing extra and does not crash when <project>/sessions/ is absent (the real-world case today)', () => {
      const rootFile = writeClaudeRootFile('project-a', 'main.jsonl');

      const result = scanSessionFiles(claudeProjectsPath, geminiBrainPath);

      expect(result).toEqual([{ path: rootFile, type: 'claude-code' }]);
    });
  });

  describe('Antigravity (Gemini) discovery', () => {
    it('excludes a conversation directory whose transcript.jsonl is not at the exact expected nested path', () => {
      // Wrong depth: transcript.jsonl directly under the conversation dir, missing .system_generated/logs/.
      const wrongDepthConv = path.join(geminiBrainPath, 'conv-wrong-depth');
      fs.mkdirSync(wrongDepthConv, { recursive: true });
      fs.writeFileSync(path.join(wrongDepthConv, 'transcript.jsonl'), '');
      // Wrong name at the otherwise-correct depth.
      const wrongNameLogsDir = path.join(geminiBrainPath, 'conv-wrong-name', '.system_generated', 'logs');
      fs.mkdirSync(wrongNameLogsDir, { recursive: true });
      fs.writeFileSync(path.join(wrongNameLogsDir, 'transcript.txt'), '');

      const result = scanSessionFiles(claudeProjectsPath, geminiBrainPath);

      expect(result).toEqual([]);
    });

    it('includes a conversation whose transcript.jsonl sits at the exact nested path', () => {
      const transcriptPath = writeGeminiTranscript('conv-1');

      const result = scanSessionFiles(claudeProjectsPath, geminiBrainPath);

      expect(result).toEqual([{ path: transcriptPath, type: 'antigravity' }]);
    });
  });

  describe('combined output', () => {
    it('combines Claude Code and Antigravity results into a single array', () => {
      const claudeFile = writeClaudeRootFile('project-a', 'session.jsonl');
      const geminiFile = writeGeminiTranscript('conv-1');

      const result = scanSessionFiles(claudeProjectsPath, geminiBrainPath);

      expect(result).toEqual(
        expect.arrayContaining([
          { path: claudeFile, type: 'claude-code' },
          { path: geminiFile, type: 'antigravity' },
        ]),
      );
      expect(result).toHaveLength(2);
    });
  });

  describe('never throws (documented contract)', () => {
    it('returns an empty array without throwing when claudeProjectsPath is a file, not a directory', () => {
      // existsSync() is true (the path exists), but readdirSync() throws ENOTDIR — exercises the
      // try/catch in scanClaudeSessions().
      const filePath = path.join(testRoot, 'not-a-directory');
      fs.writeFileSync(filePath, '');
      let result: LogFileRef[] = [];

      expect(() => {
        result = scanSessionFiles(filePath, geminiBrainPath);
      }).not.toThrow();
      expect(result).toEqual([]);
    });

    it('skips a project entry that is itself a file without aborting the scan of sibling projects', () => {
      const goodFile = writeClaudeRootFile('project-good', 'session.jsonl');
      fs.writeFileSync(path.join(claudeProjectsPath, 'not-a-project-dir'), '');

      const result = scanSessionFiles(claudeProjectsPath, geminiBrainPath);

      expect(result).toEqual([{ path: goodFile, type: 'claude-code' }]);
    });

    it('returns an empty array without throwing when geminiBrainPath is a file, not a directory', () => {
      // Mirrors the claudeProjectsPath case above, exercising the try/catch in scanGeminiSessions().
      const filePath = path.join(testRoot, 'not-a-directory-gemini');
      fs.writeFileSync(filePath, '');
      let result: LogFileRef[] = [];

      expect(() => {
        result = scanSessionFiles(claudeProjectsPath, filePath);
      }).not.toThrow();
      expect(result).toEqual([]);
    });
  });
});
