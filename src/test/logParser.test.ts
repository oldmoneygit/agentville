import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LogParser } from '../logParser';

describe('LogParser', () => {
  const tempDir = path.join(os.tmpdir(), 'claude-agents-test');
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

  it('should parse basic session details', () => {
    const parser = new LogParser();

    // Turn 1: User message and gitBranch (Claude Code format: type at top, role inside message)
    const turn1 = {
      timestamp: '2026-07-17T19:00:00.000Z',
      gitBranch: 'feature/auth-setup',
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Implement Google OAuth' }],
      },
    };

    fs.appendFileSync(tempFilePath, JSON.stringify(turn1) + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');

    expect(session.gitBranch).toBe('feature/auth-setup');
    expect(session.sessionTitle).toContain('Implement Google OAuth');
    expect(session.subagents.length).toBe(0);
  });

  it('titles a slash-command session with the real prompt, not the command scaffolding', () => {
    // Regression (Claude Code 2.1.x): a session opened with a slash command records the command
    // scaffolding as its first user turns — an isMeta caveat, then <command-*> blocks — before the
    // real prompt. Titling from the first text block gave EVERY such session the identical title
    // "<local-command-caveat>Caveat…", collapsing distinct concurrent same-branch sessions into one
    // dedupe slot (the reported "two sessions running, extension shows only one"). The title must be
    // the real prompt so the two sessions get distinct dedupe keys.
    const parser = new LogParser();
    const lines = [
      {
        timestamp: '2026-07-23T13:00:00.000Z',
        gitBranch: 'feat/738',
        type: 'user',
        isMeta: true,
        message: {
          role: 'user',
          content: '<local-command-caveat>Caveat: The messages below were generated…</local-command-caveat>',
        },
      },
      {
        timestamp: '2026-07-23T13:00:01.000Z',
        gitBranch: 'feat/738',
        type: 'user',
        message: {
          role: 'user',
          content:
            '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
        },
      },
      {
        timestamp: '2026-07-23T13:00:02.000Z',
        gitBranch: 'feat/738',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'qual worktree você esta ?' }] },
      },
    ];
    for (const l of lines) fs.appendFileSync(tempFilePath, JSON.stringify(l) + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');

    expect(session.sessionTitle).toBe('qual worktree você esta ?');
    expect(session.sessionTitle).not.toContain('local-command-caveat');
  });

  it('captures the Claude Code version stamped on the transcript for compat checks', () => {
    const parser = new LogParser();
    const turn = {
      timestamp: '2026-07-23T13:00:00.000Z',
      type: 'user',
      version: '2.1.218',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn) + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');

    expect(session.claudeVersion).toBe('2.1.218');
  });

  it('captures the session entrypoint so SDK-spawned agents can be told apart from human sessions', () => {
    const parser = new LogParser();

    // A background/workflow agent transcript stamps an sdk* entrypoint on every line; a real
    // IDE session stamps claude-vscode. The tree hides the former as a phantom sibling session.
    const agentTurn = {
      timestamp: '2026-07-17T19:00:00.000Z',
      type: 'assistant',
      entrypoint: 'sdk-py',
      message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'Reviewing' }] },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(agentTurn) + '\n');

    const session = parser.parse(tempFilePath, 'claude-code');
    expect(session.entrypoint).toBe('sdk-py');
  });

  it('should detect active and completed subagents', () => {
    const parser = new LogParser();

    // Turn 1: User message and gitBranch
    const turn1 = {
      timestamp: '2026-07-17T19:00:00.000Z',
      gitBranch: 'feature/auth-setup',
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Implement Google OAuth' }],
      },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn1) + '\n');

    // Turn 2: Subagent start
    const turn2 = {
      timestamp: '2026-07-17T19:00:01.000Z',
      type: 'tool_use',
      name: 'Agent',
      id: 'toolu_test_sub',
      input: {
        name: 'OAuth Agent',
        task: 'Review redirect configs',
      },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn2) + '\n');

    let session = parser.parse(tempFilePath, 'claude-code');
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0].name).toBe('OAuth Agent');
    expect(session.subagents[0].status).toBe('working');

    // Turn 3: Subagent finish
    const turn3 = {
      timestamp: '2026-07-17T19:00:02.000Z',
      type: 'tool_result',
      tool_use_id: 'toolu_test_sub',
      content: 'Configuration looks good',
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn3) + '\n');

    session = parser.parse(tempFilePath, 'claude-code');
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0].status).toBe('stopped');
  });

  it('should detect and complete subagents nested in message.content (real Claude Code format)', () => {
    const parser = new LogParser();

    // Turn 1: Agent tool_use nested inside message.content (what current Claude Code CLI emits)
    const turn1 = {
      timestamp: '2026-07-17T19:00:00.000Z',
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_nested_sub',
            name: 'Agent',
            input: { name: 'Nested Agent', description: 'Do work' },
          },
        ],
      },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn1) + '\n');

    let session = parser.parse(tempFilePath, 'claude-code');
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0].status).toBe('working');

    // Turn 2: tool_result nested inside message.content — this is how real transcripts
    // report completion; a top-level tool_use_id (the old assumption) never appears.
    const turn2 = {
      timestamp: '2026-07-17T19:00:01.000Z',
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_nested_sub' }],
      },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn2) + '\n');

    session = parser.parse(tempFilePath, 'claude-code');
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0].status).toBe('stopped');
  });

  it('should parse Antigravity session details and subagents', () => {
    const parser = new LogParser();

    const turn1 = {
      timestamp: '2026-07-17T19:00:00.000Z',
      gitBranch: 'main',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>Brainstorm agent extension</USER_REQUEST>',
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn1) + '\n');

    // Turn 2: Antigravity tool_calls (subagent start)
    const turn2 = {
      timestamp: '2026-07-17T19:00:01.000Z',
      tool_calls: [
        {
          id: 'tc_mock_gemini_1',
          name: 'invoke_subagent',
          arguments: {
            Task: 'Research lsof command',
          },
        },
      ],
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn2) + '\n');

    let session = parser.parse(tempFilePath, 'antigravity');

    expect(session.gitBranch).toBe('main');
    expect(session.sessionTitle).toBe('Brainstorm agent extension');
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0].id).toBe('tc_mock_gemini_1');
    expect(session.subagents[0].status).toBe('working');

    // Turn 3: Antigravity tool completion
    const turn3 = {
      timestamp: '2026-07-17T19:00:02.000Z',
      type: 'TOOL_OUTPUT',
      tool_call_id: 'tc_mock_gemini_1',
      content: 'lsof is available and fast.',
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn3) + '\n');

    session = parser.parse(tempFilePath, 'antigravity');
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0].status).toBe('stopped');
  });

  it('should cover all edge cases and branch paths in LogParser', () => {
    const parser = new LogParser();

    // 1. Test extractClaudeMessageContentName (Claude Code format)
    const turn1 = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Content array prompt' }],
      },
    };
    fs.writeFileSync(tempFilePath, JSON.stringify(turn1) + '\n');
    let session = parser.parse(tempFilePath, 'claude-code');
    expect(session.sessionTitle).toBe('Content array prompt');

    // Reset session for next tests
    fs.writeFileSync(tempFilePath, '');
    const parser2 = new LogParser();

    // 2. Test extractGenericName
    const turn2 = {
      prompt: 'Generic prompt',
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn2) + '\n');
    session = parser2.parse(tempFilePath, 'claude-code');
    expect(session.sessionTitle).toBe('Generic prompt');

    // 3. Test Claude Standalone Tool Call
    const turn3 = {
      type: 'tool_use',
      name: 'Agent',
      id: 'standalone_1',
      input: {
        task: 'Standalone task',
      },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn3) + '\n');
    session = parser2.parse(tempFilePath, 'claude-code');
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0].id).toBe('standalone_1');
    expect(session.subagents[0].status).toBe('working');

    // 4. Test Claude Standalone Completion with tool_use_id
    const turn4 = {
      tool_use_id: 'standalone_1',
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn4) + '\n');
    session = parser2.parse(tempFilePath, 'claude-code');
    expect(session.subagents[0].status).toBe('stopped');

    // 5. Test Antigravity tool call with missing ID
    const turn5 = {
      tool_calls: [
        {
          name: 'invoke_subagent',
          arguments: {
            Task: 'No ID task',
          },
        },
      ],
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn5) + '\n');
    session = parser2.parse(tempFilePath, 'antigravity');
    expect(session.subagents.length).toBe(2);
    expect(session.subagents[1].status).toBe('working');
  });

  it('recovers a subagent launch line torn mid-write once the writer finishes it', () => {
    // Regression: a file-watcher tick (or the 15s auto-refresh) can call parse() at the exact
    // moment Claude Code has only partially flushed a line. The old code advanced lastReadOffset
    // to fileSize unconditionally, so the torn fragment's bytes were skipped forever — the next
    // read started mid-JSON and failed again, permanently losing the entry (here, a subagent
    // launch that would otherwise show the session as still running).
    const parser = new LogParser();

    const turn1 = {
      timestamp: '2026-07-17T19:00:00.000Z',
      gitBranch: 'feature/auth-setup',
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Implement Google OAuth' }] },
    };
    fs.appendFileSync(tempFilePath, JSON.stringify(turn1) + '\n');

    const turn2 = {
      timestamp: '2026-07-17T19:00:01.000Z',
      type: 'tool_use',
      name: 'Agent',
      id: 'toolu_torn_launch',
      input: { name: 'OAuth Agent', task: 'Review redirect configs' },
    };
    const turn2Line = JSON.stringify(turn2) + '\n';
    // Simulate the watcher catching the write ~40% into the line — no trailing '\n' yet.
    const tornPrefix = turn2Line.slice(0, Math.floor(turn2Line.length * 0.4));
    fs.appendFileSync(tempFilePath, tornPrefix);

    let session = parser.parse(tempFilePath, 'claude-code');
    expect(session.gitBranch).toBe('feature/auth-setup');
    expect(session.subagents.length).toBe(0);

    // The writer finishes the line.
    fs.appendFileSync(tempFilePath, turn2Line.slice(tornPrefix.length));

    // Same LogParser instance — its cached offset must have retreated to before the torn
    // fragment, not past it, for this second call to see the now-complete line.
    session = parser.parse(tempFilePath, 'claude-code');
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0].name).toBe('OAuth Agent');
    expect(session.subagents[0].status).toBe('working');
  });

  it('recovers a line torn inside a multibyte character, using byte offsets not string length', () => {
    // Locks the Buffer.byteLength(…, 'utf8') requirement: transcripts contain multibyte UTF-8
    // (accents, emoji). Retreating the offset by a UTF-16 code-unit count instead of a byte count
    // would land the next read at the wrong byte position — corrupting or re-losing the entry —
    // even though the plain-ASCII case above would still pass.
    const parser = new LogParser();

    const turn = {
      timestamp: '2026-07-17T19:00:01.000Z',
      type: 'tool_use',
      name: 'Agent',
      id: 'toolu_multibyte',
      input: { name: 'Café Agent ☕', task: 'handle 🚀 emoji across a torn read' },
    };
    const fullLine = JSON.stringify(turn) + '\n';
    const fullBuffer = Buffer.from(fullLine, 'utf8');

    // Cut 2 bytes into the 4-byte UTF-8 encoding of the 🚀 emoji, so the fragment on disk ends
    // mid-character — a plain string slice couldn't reliably reproduce this (JS strings are
    // UTF-16), so the cut is computed on the encoded bytes instead.
    const emojiIndex = fullLine.indexOf('🚀');
    const byteOffsetOfEmoji = Buffer.byteLength(fullLine.slice(0, emojiIndex), 'utf8');
    const cutPoint = byteOffsetOfEmoji + 2;

    fs.writeFileSync(tempFilePath, fullBuffer.subarray(0, cutPoint));

    let session = parser.parse(tempFilePath, 'claude-code');
    expect(session.subagents.length).toBe(0);

    // The writer finishes the line — append the remaining bytes (rest of the emoji + rest of JSON).
    fs.appendFileSync(tempFilePath, fullBuffer.subarray(cutPoint));

    session = parser.parse(tempFilePath, 'claude-code');
    expect(session.subagents.length).toBe(1);
    expect(session.subagents[0].name).toBe('Café Agent ☕');
  });
});
