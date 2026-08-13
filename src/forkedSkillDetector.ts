import { SubAgent } from './types';
import type { LogEntry } from './logParser';

/**
 * Since Claude Code 2.1.218 (observed on 2.1.222), a skill invoked with `context: fork` (e.g.
 * `/code-review`) runs as a backgrounded subagent, but its launch is NOT a `tool_use` block —
 * subagentDetector.ts's detectClaudeCalls/detectClaudeStandaloneCalls never see it. Instead it's
 * a `type: "system"` entry whose TOP-LEVEL `content` string embeds a
 * `<forked-skill-launch>{...}</forked-skill-launch>` JSON payload (real example:
 * `{"agentId":"a2e15c98935a695a32","skillName":"code-review","description":"/code-review"}`).
 * Its sidecar carries no `toolUseId`, so subagentMetadata's enrichment join never finds it —
 * name/task are set directly from the payload here instead.
 *
 * The `type === 'system'` gate is load-bearing, not incidental: agent reports routinely paste
 * this same tag+JSON verbatim into their own text (e.g. echoing a launch back), and reading it
 * via subagentDetector.ts's getEntryText() (which aggregates message.content/attachment.prompt)
 * would fabricate a phantom subagent from quoted text. Reading ONLY the top-level `content`
 * string keeps this detector blind to that quoted form.
 *
 * Claude-Code-only: Antigravity has no forked-skill equivalent, and its tool_calls-shaped
 * entries never carry `type: "system"` with this content, so no explicit no-op branch is
 * needed here (contrast detectSendMessageResume's explicit Antigravity note).
 */
export function detectForkedSkillLaunch(json: LogEntry, currentSubagents: Map<string, SubAgent>): void {
  if (json.type !== 'system' || typeof json.content !== 'string') {
    return;
  }
  const payload = parseForkedSkillLaunchPayload(json.content);
  if (!payload) {
    return;
  }
  currentSubagents.set(payload.agentId, {
    id: payload.agentId,
    agentId: payload.agentId,
    name: payload.skillName || 'Agent',
    task: payload.description || 'Delegate task',
    status: 'working',
  });
}

interface ForkedSkillPayload {
  agentId: string;
  skillName?: string;
  description?: string;
}

/** Parses the <forked-skill-launch> tag's JSON payload. Mirrors subagentMetadata.ts's
 * readSidecarFile: this format is undocumented and unversioned, so parsing never throws —
 * malformed JSON, a non-object payload, or a missing/non-string agentId are silent no-ops. */
function parseForkedSkillLaunchPayload(content: string): ForkedSkillPayload | undefined {
  // Delimiters are fixed strings, so indexOf is linear-time over this untrusted payload — the
  // equivalent regex measured quadratic worst-case time on pathological (many-unclosed-tag) input.
  const OPEN = '<forked-skill-launch>';
  const CLOSE = '</forked-skill-launch>';
  const start = content.indexOf(OPEN);
  if (start === -1) {
    return undefined;
  }
  const end = content.indexOf(CLOSE, start + OPEN.length);
  if (end === -1) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start + OPEN.length, end));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const fields = parsed as Record<string, unknown>;
  const agentId = typeof fields.agentId === 'string' ? fields.agentId : undefined;
  if (!agentId) {
    return undefined;
  }
  return {
    agentId,
    skillName: typeof fields.skillName === 'string' ? fields.skillName : undefined,
    description: typeof fields.description === 'string' ? fields.description : undefined,
  };
}
