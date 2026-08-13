import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LogParser } from '../logParser';

// Claude Code encodes a session's cwd into its ~/.claude/projects directory name by replacing
// every character that isn't [A-Za-z0-9] — path separators, '.', '_', spaces, accented letters'
// punctuation — with a single '-'. That makes the encoding lossy: "/Users/x/aia_harness" and a
// hypothetical "/Users/x/aia-harness" both encode to "...-aia-harness". Decoding the directory
// name back into a real path (decodeClaudeProjectPath) is therefore only a best-effort guess.
//
// The actual fix: every real transcript line Claude Code writes carries the true `cwd` verbatim.
// detectProjectPath() must prefer that real value over the decoded guess, for every OS/naming
// pattern a project folder can have. That's what this suite locks in.
describe('LogParser project path resolution', () => {
  let claudeProjectsDir: string;

  beforeEach(() => {
    claudeProjectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-test-'));
  });

  afterEach(() => {
    fs.rmSync(claudeProjectsDir, { recursive: true, force: true });
  });

  function writeSessionFile(encodedProjectDir: string, cwd: string): string {
    const projectDir = path.join(claudeProjectsDir, encodedProjectDir);
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, 'session.jsonl');
    const line = JSON.stringify({
      type: 'user',
      cwd,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    fs.writeFileSync(filePath, line + '\n');
    return filePath;
  }

  describe('real cwd from the transcript always wins over the decoded directory-name guess', () => {
    const cases: Array<[string, string]> = [
      ['macOS path with an underscore (the exact reported bug: "aia_harness")', '/Users/dev/Projetos/aia_harness'],
      ['Linux path with an underscore and spaces', '/home/dev/My Projects/data_pipeline'],
      ['macOS/Linux path with accented characters', '/Users/dev/Projetos/café_ação'],
      ['path with a dot (version-style folder name)', '/Users/dev/Projetos/app.v2'],
      ['path whose real folder name already contains dashes', '/Users/dev/Projetos/claude-agents-view-vscode'],
      ['Windows-style drive path', 'C:\\Users\\dev\\Projects\\my_app'],
    ];

    it.each(cases)('%s', (_label, realCwd) => {
      const parser = new LogParser(claudeProjectsDir);
      // Deliberately use an encoded directory name that does NOT match realCwd's own encoding —
      // proving the fix doesn't depend on decoding the directory name correctly at all.
      const filePath = writeSessionFile('-some-encoded-guess', realCwd);

      const session = parser.parse(filePath, 'claude-code');

      expect(session.projectPath).toBe(realCwd);
    });

    it('re-derives projectName from the real cwd, not the decoded directory-name guess', () => {
      const parser = new LogParser(claudeProjectsDir);
      const filePath = writeSessionFile('-totally-wrong-guess', '/Users/dev/Projetos/aia_harness');

      const session = parser.parse(filePath, 'claude-code');

      expect(session.projectName).toBe('aia_harness');
    });
  });

  describe('decodeClaudeProjectPath fallback (used only before any transcript line has been read)', () => {
    // decodeClaudeProjectPath reconstructs the path by checking fs.existsSync from the real
    // filesystem root, so these two tests need a real ancestor directory whose own name is
    // guaranteed clean (no '_'/' '/accents) — os.tmpdir() itself can contain a literal '_' on
    // macOS (e.g. /var/folders/xx/xxxxx_xxxx/T), which would contaminate the very ambiguity
    // being tested. '/tmp' is always plain alnum + '/' on POSIX, but doesn't exist on Windows
    // (and mkdtempSync won't create it), so there we fall back to os.tmpdir() and skip only when
    // that root is itself dirty — it sits under the user profile, which *may* carry a space
    // ("C:\Users\John Doe\...") but usually doesn't. Gating on the root instead of on the platform
    // keeps the coverage on every Windows box where these tests can still prove anything.
    const cleanRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const rootIsAmbiguous = /[^A-Za-z0-9:\\/]/.test(cleanRoot);

    it.skipIf(rootIsAmbiguous)('recovers a real folder whose name is itself hyphenated', () => {
      const realProjectRoot = fs.mkdtempSync(path.join(cleanRoot, 'decode-test-'));
      const realProjectDir = path.join(realProjectRoot, 'claude-agents-view-vscode');
      fs.mkdirSync(realProjectDir);

      try {
        const encodedName = realProjectDir.replace(/[^A-Za-z0-9]/g, '-');
        const parser = new LogParser(claudeProjectsDir);
        const missingFilePath = path.join(claudeProjectsDir, encodedName, 'session.jsonl');

        const session = parser.parse(missingFilePath, 'claude-code');

        expect(session.projectPath).toBe(realProjectDir);
      } finally {
        fs.rmSync(realProjectRoot, { recursive: true, force: true });
      }
    });

    it.skipIf(rootIsAmbiguous)(
      'cannot recover an underscore in the real folder name (known heuristic limitation, fixed by the cwd override above)',
      () => {
        const realProjectRoot = fs.mkdtempSync(path.join(cleanRoot, 'decode-test-'));
        const realProjectDir = path.join(realProjectRoot, 'aia_harness');
        fs.mkdirSync(realProjectDir);

        try {
          const encodedName = realProjectDir.replace(/[^A-Za-z0-9]/g, '-');
          const parser = new LogParser(claudeProjectsDir);
          const missingFilePath = path.join(claudeProjectsDir, encodedName, 'session.jsonl');

          const session = parser.parse(missingFilePath, 'claude-code');

          // '_' and '/' both collapsed to '-' during encoding, so the guess can't tell them apart.
          expect(session.projectPath).not.toBe(realProjectDir);
        } finally {
          fs.rmSync(realProjectRoot, { recursive: true, force: true });
        }
      },
    );
  });
});
