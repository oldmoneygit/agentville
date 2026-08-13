import { describe, it, expect } from 'vitest';
import { detectSubagents } from '../subagentDetector';
import { SubAgent } from '../types';
import { LogEntry } from '../logParser';

/**
 * Real transcript evidence (a northwind-app session log — see subagentDetector.ts's
 * detectSendMessageResume doc comment): SendMessage({to, message}) can resume a subagent that
 * already reported completion. Fixtures below mirror the real shapes observed for each step.
 * `as LogEntry` is used where a fixture needs a field (`input.to`, `toolUseResult.resumedAgentId`)
 * that is real but not part of LogEntry's necessarily-partial typed shape (per transcriptEntry.ts's
 * own doc comment: "every field is optional because shapes vary by tool, version, and entry type").
 */
describe('detectSubagents — SendMessage resume', () => {
  function launchTurn(id: string, name: string): LogEntry {
    return {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { name, description: 'Delegate task' } }] },
    };
  }

  // No `input.name` — mirrors a real launch that never set one (confirmed against real sidecars:
  // only 2 of 4 launches in one session passed `name`). SubAgent.name stays the 'Agent'
  // placeholder, so a resume can only match by agentId.
  function launchTurnNoName(id: string): LogEntry {
    return {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Delegate task' } }] },
    };
  }

  function completionTurn(toolUseId: string): LogEntry {
    return {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
      toolUseResult: { status: 'completed' },
    };
  }

  function sendMessageTurn(id: string, to: string): LogEntry {
    // `input.to`/`input.message` aren't part of LogEntry's typed `input` shape (see the file-level
    // comment) and share no property names with it, so a direct `as LogEntry` is rejected as
    // "insufficient overlap" — route through `unknown` first, same as production code does.
    return {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'resume please' } }],
      },
    } as unknown as LogEntry;
  }

  function sendMessageAckTurn(toolUseId: string, resumedAgentId: string): LogEntry {
    return {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
      toolUseResult: {
        success: true,
        message: 'Agent had no active task; resumed from transcript in the background',
        resumedAgentId,
        pin: { id: resumedAgentId, name: 'regression-logic', ref: '5c75c6' },
      },
    } as LogEntry;
  }

  function taskNotificationTurn(toolUseId: string): LogEntry {
    return {
      type: 'user',
      message: {
        content: `<task-notification>\n<task-id>ae9f0a218b203f23b</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
      },
    };
  }

  it('marks the subagent working again when SendMessage resumes it after completion', () => {
    const subagents = new Map<string, SubAgent>();
    detectSubagents(launchTurn('toolu_launch_1', 'regression-logic'), subagents);
    detectSubagents(completionTurn('toolu_launch_1'), subagents);
    expect(subagents.get('toolu_launch_1')?.status).toBe('stopped');

    detectSubagents(sendMessageTurn('toolu_resume_1', 'regression-logic'), subagents);

    expect(subagents.has('toolu_launch_1')).toBe(false); // re-keyed away from the old launch id
    expect(subagents.size).toBe(1);
    const resumed = subagents.get('toolu_resume_1');
    expect(resumed?.status).toBe('working');
    expect(resumed?.name).toBe('regression-logic');
    expect(resumed?.launchId).toBe('toolu_launch_1'); // preserved so subagentMetadata's sidecar join keeps matching
  });

  it('does not mark the subagent stopped on the immediate SendMessage resume ACK', () => {
    const subagents = new Map<string, SubAgent>();
    detectSubagents(launchTurn('toolu_launch_1', 'regression-logic'), subagents);
    detectSubagents(completionTurn('toolu_launch_1'), subagents);
    detectSubagents(sendMessageTurn('toolu_resume_1', 'regression-logic'), subagents);

    detectSubagents(sendMessageAckTurn('toolu_resume_1', 'ae9f0a218b203f23b'), subagents);

    expect(subagents.get('toolu_resume_1')?.status).toBe('working');
  });

  it('marks the subagent stopped when the task-notification carries the SendMessage tool-use id', () => {
    const subagents = new Map<string, SubAgent>();
    detectSubagents(launchTurn('toolu_launch_1', 'regression-logic'), subagents);
    detectSubagents(completionTurn('toolu_launch_1'), subagents);
    detectSubagents(sendMessageTurn('toolu_resume_1', 'regression-logic'), subagents);
    detectSubagents(sendMessageAckTurn('toolu_resume_1', 'ae9f0a218b203f23b'), subagents);

    detectSubagents(taskNotificationTurn('toolu_resume_1'), subagents);

    expect(subagents.get('toolu_resume_1')?.status).toBe('stopped');
  });

  it('is a no-op when SendMessage targets an unknown agent', () => {
    const subagents = new Map<string, SubAgent>();
    detectSubagents(launchTurn('toolu_launch_1', 'regression-logic'), subagents);

    detectSubagents(sendMessageTurn('toolu_resume_1', 'some-other-agent'), subagents);

    expect(subagents.size).toBe(1);
    expect(subagents.has('toolu_resume_1')).toBe(false);
    expect(subagents.get('toolu_launch_1')?.status).toBe('working');
  });

  it('resumes by agentId when the launch never set a name', () => {
    const subagents = new Map<string, SubAgent>();
    detectSubagents(launchTurnNoName('toolu_launch_1'), subagents);
    detectSubagents(completionTurn('toolu_launch_1'), subagents);
    // Simulates enrichSubagentMetadata() (subagentMetadata.ts) having already run and populated
    // agentId from the sidecar filename — that's the real-world source, out of scope here.
    const launched = subagents.get('toolu_launch_1');
    expect(launched).toBeDefined();
    launched!.agentId = 'ad2d7960e4bd708a3a';

    detectSubagents(sendMessageTurn('toolu_resume_1', 'ad2d7960e4bd708a3a'), subagents);

    expect(subagents.has('toolu_launch_1')).toBe(false);
    const resumed = subagents.get('toolu_resume_1');
    expect(resumed?.status).toBe('working');
    expect(resumed?.agentId).toBe('ad2d7960e4bd708a3a');
  });

  it('keeps launchId pointing at the original launch across a second resume', () => {
    const subagents = new Map<string, SubAgent>();
    detectSubagents(launchTurn('toolu_launch_1', 'regression-logic'), subagents);
    detectSubagents(completionTurn('toolu_launch_1'), subagents);
    detectSubagents(sendMessageTurn('toolu_resume_1', 'regression-logic'), subagents);
    detectSubagents(sendMessageAckTurn('toolu_resume_1', 'ae9f0a218b203f23b'), subagents);
    detectSubagents(taskNotificationTurn('toolu_resume_1'), subagents);
    expect(subagents.get('toolu_resume_1')?.status).toBe('stopped');

    detectSubagents(sendMessageTurn('toolu_resume_2', 'regression-logic'), subagents);

    expect(subagents.has('toolu_resume_1')).toBe(false);
    const resumedAgain = subagents.get('toolu_resume_2');
    expect(resumedAgain?.status).toBe('working');
    expect(resumedAgain?.launchId).toBe('toolu_launch_1');
  });
});

/**
 * Since Claude Code 2.1.218 (observed on 2.1.222), a skill invoked with `context: fork`
 * (e.g. `/code-review`) runs as a backgrounded subagent, but its launch is a `type: "system"`,
 * `subtype: "local_command"` entry whose TOP-LEVEL `content` string embeds a
 * `<forked-skill-launch>{...}</forked-skill-launch>` JSON payload — never a `tool_use` block,
 * so none of the existing start detectors see it. Its completion notification carries only
 * `<task-id>` (which IS the agentId), never `<tool-use-id>` (see subagentDetector.ts's
 * detectTaskNotificationCompletion doc comment).
 */
describe('detectSubagents — forked skill launch (context: fork)', () => {
  // Copied verbatim from a real transcript (see subagentDetector.ts's detectForkedSkillLaunch
  // doc comment for the corpus stats behind this shape).
  const REAL_FORKED_SKILL_LAUNCH_LINE =
    '{"parentUuid":"bb9b8268-ae7c-48c9-a26a-7a92c5e886d7","isSidechain":false,"type":"system","subtype":"local_command","content":"<local-command-stdout>Running in the background as @code-review</local-command-stdout>\\n<forked-skill-launch>{\\"agentId\\":\\"a2e15c98935a695a32\\",\\"skillName\\":\\"code-review\\",\\"description\\":\\"/code-review\\"}</forked-skill-launch>","level":"info","timestamp":"2026-08-05T22:22:23.553Z","uuid":"d4ec8274-75fd-4065-9ebe-08165b6a0de6","isMeta":false,"userType":"external","entrypoint":"cli","cwd":"/Users/dev/acme-dashboard","sessionId":"a1e1ffab-369c-4b19-a7f8-1bf4eeacc898","version":"2.1.222","gitBranch":"feature/sample-api-integration-refresh"}';

  // The forked-skill notification carries only <task-id> (the agentId) — never <tool-use-id>,
  // since there was no tool_use to carry one. Covers all 3 shapes getEntryText() reads.
  function forkedSkillTaskNotification(
    taskId: string,
    shape: 'queue-operation' | 'user-turn' | 'attachment-prompt',
  ): LogEntry {
    const text = `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>Agent "/code-review" finished</summary>\n</task-notification>`;
    if (shape === 'queue-operation') {
      return { type: 'queue-operation', content: text };
    }
    if (shape === 'attachment-prompt') {
      return { type: 'queued_command', attachment: { prompt: text } };
    }
    return { type: 'user', message: { content: text } };
  }

  // `input.to`/`input.message` aren't part of LogEntry's typed `input` shape (mirrors the
  // 'SendMessage resume' describe block above) — route through `unknown` first.
  function sendMessageTurn(id: string, to: string): LogEntry {
    return {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'resume please' } }] },
    } as unknown as LogEntry;
  }

  it('creates exactly one working subagent from the real forked-skill-launch transcript line', () => {
    const subagents = new Map<string, SubAgent>();
    const entry = JSON.parse(REAL_FORKED_SKILL_LAUNCH_LINE) as LogEntry;

    detectSubagents(entry, subagents);

    expect(subagents.size).toBe(1);
    const sub = subagents.get('a2e15c98935a695a32');
    expect(sub?.id).toBe('a2e15c98935a695a32');
    expect(sub?.agentId).toBe('a2e15c98935a695a32');
    expect(sub?.name).toBe('code-review');
    expect(sub?.task).toBe('/code-review');
    expect(sub?.status).toBe('working');
  });

  it('marks the forked-skill subagent stopped via a queue-operation task-notification carrying only <task-id>', () => {
    const subagents = new Map<string, SubAgent>();
    detectSubagents(JSON.parse(REAL_FORKED_SKILL_LAUNCH_LINE) as LogEntry, subagents);

    detectSubagents(forkedSkillTaskNotification('a2e15c98935a695a32', 'queue-operation'), subagents);

    expect(subagents.get('a2e15c98935a695a32')?.status).toBe('stopped');
  });

  it('marks the forked-skill subagent stopped via a user-turn task-notification carrying only <task-id>', () => {
    const subagents = new Map<string, SubAgent>();
    detectSubagents(JSON.parse(REAL_FORKED_SKILL_LAUNCH_LINE) as LogEntry, subagents);

    detectSubagents(forkedSkillTaskNotification('a2e15c98935a695a32', 'user-turn'), subagents);

    expect(subagents.get('a2e15c98935a695a32')?.status).toBe('stopped');
  });

  it('marks the forked-skill subagent stopped via an attachment.prompt task-notification carrying only <task-id>', () => {
    const subagents = new Map<string, SubAgent>();
    detectSubagents(JSON.parse(REAL_FORKED_SKILL_LAUNCH_LINE) as LogEntry, subagents);

    detectSubagents(forkedSkillTaskNotification('a2e15c98935a695a32', 'attachment-prompt'), subagents);

    expect(subagents.get('a2e15c98935a695a32')?.status).toBe('stopped');
  });

  it('does not fabricate a subagent when a non-system entry merely echoes a forked-skill-launch tag in its text', () => {
    // Real scenario: an agent's own report pastes the tag+JSON verbatim into conversational text.
    // Must NOT be read via message.content (the same field getEntryText aggregates elsewhere).
    const subagents = new Map<string, SubAgent>();
    const echoedTag =
      '<forked-skill-launch>{"agentId":"a2e15c98935a695a32","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';
    const assistantEcho: LogEntry = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: `Launch payload was: ${echoedTag}` }] },
    };

    detectSubagents(assistantEcho, subagents);

    expect(subagents.size).toBe(0);
  });

  it('is a no-op when the forked-skill-launch JSON is malformed', () => {
    const subagents = new Map<string, SubAgent>();
    const entry: LogEntry = {
      type: 'system',
      content: '<forked-skill-launch>{not valid json</forked-skill-launch>',
    };

    detectSubagents(entry, subagents);

    expect(subagents.size).toBe(0);
  });

  it('is a no-op when the forked-skill-launch payload has no agentId', () => {
    const subagents = new Map<string, SubAgent>();
    const entry: LogEntry = {
      type: 'system',
      content: '<forked-skill-launch>{"skillName":"code-review","description":"/code-review"}</forked-skill-launch>',
    };

    detectSubagents(entry, subagents);

    expect(subagents.size).toBe(0);
  });

  it('is a no-op when the forked-skill-launch payload has a non-string agentId', () => {
    const subagents = new Map<string, SubAgent>();
    const entry: LogEntry = {
      type: 'system',
      content:
        '<forked-skill-launch>{"agentId":12345,"skillName":"code-review","description":"/code-review"}</forked-skill-launch>',
    };

    detectSubagents(entry, subagents);

    expect(subagents.size).toBe(0);
  });

  it('still marks a classic subagent stopped by <tool-use-id> when the notification also carries <task-id>', () => {
    const subagents = new Map<string, SubAgent>();
    const classicLaunch: LogEntry = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_classic_1', name: 'Agent', input: { description: 'Delegate task' } }],
      },
    };
    detectSubagents(classicLaunch, subagents);

    // Real classic shape (see subagentDetector.ts's detectTaskNotificationCompletion doc
    // comment): carries BOTH tags, unlike the forked-skill notification above.
    const classicNotification: LogEntry = {
      type: 'user',
      message: {
        content:
          '<task-notification>\n<task-id>a18f77b80893cf121</task-id>\n<tool-use-id>toolu_classic_1</tool-use-id>\n<status>killed</status>\n</task-notification>',
      },
    };
    detectSubagents(classicNotification, subagents);

    expect(subagents.get('toolu_classic_1')?.status).toBe('stopped');
    expect(subagents.has('a18f77b80893cf121')).toBe(false); // its own <task-id> is not a map key — no side effect
  });

  it('marks a resumed forked-skill subagent stopped via <task-id> falling back to its agentId after SendMessage re-keyed it', () => {
    // DEFENSIVE, not yet observed in production: the one real resume transcript seen carried
    // BOTH tags, and <tool-use-id> already resolved it there. This guards the plausible case
    // where a post-resume notification carries only <task-id> — without the agentId fallback,
    // a raw map.get(id) misses (SendMessage's reactivateSubagent re-keyed the entry off the
    // agentId), leaving the subagent stuck 'working' forever, which pins the whole parent
    // session 'working' too via sessionDedupe.applyNestedAgentLiveness.
    const subagents = new Map<string, SubAgent>();
    detectSubagents(JSON.parse(REAL_FORKED_SKILL_LAUNCH_LINE) as LogEntry, subagents);

    detectSubagents(sendMessageTurn('toolu_resume_1', 'code-review'), subagents);
    expect(subagents.has('a2e15c98935a695a32')).toBe(false); // re-keyed away, same as the classic resume case
    expect(subagents.get('toolu_resume_1')?.agentId).toBe('a2e15c98935a695a32');

    detectSubagents(forkedSkillTaskNotification('a2e15c98935a695a32', 'queue-operation'), subagents);

    expect(subagents.get('toolu_resume_1')?.status).toBe('stopped');
  });
});
