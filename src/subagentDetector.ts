import { SubAgent } from './types';
import type { LogEntry } from './logParser';
import { detectForkedSkillLaunch } from './forkedSkillDetector';

/** Detect subagent starts/completions from one log entry and mutate the running map. */
export function detectSubagents(json: LogEntry, currentSubagents: Map<string, SubAgent>): void {
  detectAntigravityCalls(json, currentSubagents);
  detectClaudeCalls(json, currentSubagents);
  detectSendMessageResume(json, currentSubagents);
  detectClaudeStandaloneCalls(json, currentSubagents);
  detectForkedSkillLaunch(json, currentSubagents);
  detectCompletions(json, currentSubagents);
}

function detectAntigravityCalls(json: LogEntry, currentSubagents: Map<string, SubAgent>): void {
  if (json.tool_calls && Array.isArray(json.tool_calls)) {
    for (const tc of json.tool_calls) {
      if (isAntigravitySubagent(tc)) {
        const id = getAntigravityId(tc);
        const task = getAntigravityTask(tc);
        const name = getAntigravityName(tc);
        currentSubagents.set(id, { id, name, task, status: 'working' });
      }
    }
  }
}

function isAntigravitySubagent(tc: { name?: string; ToolName?: string }): boolean {
  const name = tc.name || tc.ToolName;
  return name === 'invoke_subagent' || name === 'browser_subagent';
}

function getAntigravityId(tc: { id?: string; TaskId?: string }): string {
  return tc.id || tc.TaskId || Math.random().toString();
}

function getAntigravityTask(tc: {
  arguments?: { Task?: string; TaskName?: string; Cwd?: string; SearchPath?: string; DirectoryPath?: string };
  Arguments?: { Task?: string; TaskName?: string; Cwd?: string };
}): string {
  const args = tc.arguments || tc.Arguments;
  return args?.Task || args?.TaskName || 'Subagent task';
}

function getAntigravityName(tc: { name?: string; ToolName?: string }): string {
  return tc.name || tc.ToolName || 'subagent';
}

function detectClaudeCalls(json: LogEntry, currentSubagents: Map<string, SubAgent>): void {
  if (json.message && Array.isArray(json.message.content)) {
    for (const block of json.message.content) {
      if (isClaudeAgentTool(block)) {
        const id = block.id || Math.random().toString();
        currentSubagents.set(id, {
          id,
          name: getClaudeName(block),
          task: getClaudeTask(block),
          status: 'working',
          model: getClaudeModel(block),
        });
      }
    }
  }
}

function isClaudeAgentTool(block: { type: string; name?: string }): boolean {
  return block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'agent');
}

function getClaudeTask(block: { input?: { task?: string; Task?: string; description?: string } }): string {
  // The Agent tool uses `description` (there is no `task` field); keep task/Task for other formats.
  return block.input?.task || block.input?.Task || block.input?.description || 'Delegate task';
}

function getClaudeName(block: { input?: { name?: string } }): string {
  return block.input?.name || 'Agent';
}

function getClaudeModel(block: { input?: { model?: string } }): string | undefined {
  return block.input?.model;
}

/**
 * `SendMessage({to, message})` can resume a subagent that already reported completion — Claude
 * Code re-invokes it from its saved transcript in the background instead of erroring. Real
 * transcript evidence (a northwind-app session log): an agent finished at 20:51:44Z; 13m15s later a
 * SendMessage addressed to its name silently restarted it, and the subagent stayed 'stopped' in
 * the map that whole time because nothing recognized the resume — sessionActivity's
 * hasRunningAgents saw no working subagent and the whole session read as idle.
 *
 * `to` can be the subagent's NAME (`to: "regression-logic"`) or, when the launch never set a
 * `name`, its raw agentId (`to: "ad2d7960e4bd708a3a"`, format `a<hex>`) — confirmed against real
 * sidecars from the same session: only 2 of 4 launches passed `name`, so the other 2 are only
 * addressable by agentId. findSubagentEntryByTarget matches either, since neither is the id this
 * map is keyed under.
 *
 * Once matched, the map entry is RE-KEYED to the SendMessage tool_use's own id — Claude Code's
 * eventual <task-notification> for this resume carries THAT id, not the original launch's, so
 * markStopped() needs no change to find it later (see detectTaskNotificationCompletion). The
 * ORIGINAL launch id is stashed in `sub.launchId` before the rekey (set once — a later resume
 * never overwrites it), because the sidecar `enrichSubagentMetadata` reads is written at launch
 * time and keeps THAT id as its `toolUseId` forever; without `launchId`, re-keying `sub.id` would
 * silently break that join and the resumed subagent would never get its real name/model (see
 * subagentMetadata.ts).
 *
 * An unmatched `to` (name or agentId form) is a silent no-op: never fabricate a subagent from a
 * SendMessage alone.
 *
 * Antigravity has no SendMessage equivalent, so nothing is done for it here — its own
 * re-invocation of an existing tool call already flips the matching id back to 'working' via
 * detectAntigravityCalls's unconditional `set()`.
 */
function detectSendMessageResume(json: LogEntry, currentSubagents: Map<string, SubAgent>): void {
  if (json.message && Array.isArray(json.message.content)) {
    for (const block of json.message.content) {
      if (!isSendMessageCall(block) || !block.id) {
        continue;
      }
      const to = getSendMessageTarget(block);
      if (!to) {
        continue;
      }
      const entry = findSubagentEntryByTarget(currentSubagents, to);
      if (!entry) {
        continue;
      }
      reactivateSubagent(currentSubagents, entry, block.id);
    }
  }
}

/** Re-keys the map entry to the SendMessage's own tool_use id and flips it back to 'working'.
 * `launchId` is set once — on the FIRST resume only, when it's still unset — so a later resume
 * never overwrites the original launch id it needs to keep pointing at (see
 * detectSendMessageResume's doc comment on why that id must survive the rekey). */
function reactivateSubagent(currentSubagents: Map<string, SubAgent>, entry: [string, SubAgent], newId: string): void {
  const [oldId, sub] = entry;
  currentSubagents.delete(oldId);
  if (sub.launchId === undefined) {
    sub.launchId = oldId;
  }
  sub.status = 'working';
  sub.id = newId;
  currentSubagents.set(newId, sub);
}

function isSendMessageCall(block: { type: string; name?: string }): boolean {
  return block.type === 'tool_use' && block.name === 'SendMessage';
}

function getSendMessageTarget(block: { input?: unknown }): string | undefined {
  // `to` isn't part of LogEntry's typed `input` shape — this fix stays scoped to
  // subagentDetector.ts, so `input` is read as unknown and narrowed locally here instead of
  // widening the shared parser type (mirrors subagentMetadata.ts's sidecar field reads).
  const input = block.input as Record<string, unknown> | undefined;
  return typeof input?.to === 'string' ? input.to : undefined;
}

/** Last (most recently launched) match wins on a reused name/agentId — Map iteration is insertion
 * order, and a relaunch always gets a fresh key, so "last" means "newest". Matches by name (the
 * common case, when the launch passed one) or by the sidecar-derived agentId (subagentMetadata.ts)
 * for a launch that didn't — SendMessage's `to` can address either form. */
function findSubagentEntryByTarget(
  currentSubagents: Map<string, SubAgent>,
  target: string,
): [string, SubAgent] | undefined {
  let found: [string, SubAgent] | undefined;
  for (const entry of currentSubagents) {
    if (entry[1].name === target || entry[1].agentId === target) {
      found = entry;
    }
  }
  return found;
}

function detectClaudeStandaloneCalls(json: LogEntry, currentSubagents: Map<string, SubAgent>): void {
  if (isClaudeStandaloneCall(json)) {
    const id = json.id || Math.random().toString();
    currentSubagents.set(id, {
      id,
      name: getClaudeName(json),
      task: getClaudeTask(json),
      status: 'working',
      model: getClaudeModel(json),
    });
  }
}

function isClaudeStandaloneCall(json: LogEntry): boolean {
  return json.type === 'tool_use' && (json.name === 'Agent' || json.name === 'agent');
}

function detectCompletions(json: LogEntry, currentSubagents: Map<string, SubAgent>): void {
  // A backgrounded Agent gets its tool_result ~100ms after launch, carrying
  // toolUseResult.status === 'async_launched'. That ACKs the launch — it does NOT mean the agent
  // finished (observed: an agent ACKed at 17:58:09 only really finished at 18:07:06). Counting it
  // as a completion marked every async subagent "stopped" on the spot, so long-running agents
  // never appeared under "Working Agents". Their real completion is the <task-notification> below.
  // A SendMessage that resumes an already-completed subagent (detectSendMessageResume) gets its
  // own ACK ~200ms later, carrying the SAME tool_use_id the subagent was just re-keyed under.
  // Unlike the Agent tool's tool_result, this ACK has no `status` field at all — its real shape
  // (confirmed against the same transcript evidence cited on detectSendMessageResume) is
  // {success, message, resumedAgentId, pin}. Counting either ACK as a completion would flip the
  // subagent back to 'stopped' immediately, undoing the launch/resume it just ACKed. Both real
  // completions arrive later as the <task-notification> below, carrying the same id either way.
  if (isLaunchOrResumeAck(json)) {
    return;
  }

  // Antigravity completions carry tool_call_id; standalone Claude tool_result carries tool_use_id.
  if (json.type === 'TOOL_OUTPUT' && json.tool_call_id) {
    markStopped(currentSubagents, json.tool_call_id);
  }
  if (json.tool_use_id) {
    markStopped(currentSubagents, json.tool_use_id);
  }
  // Real Claude Code transcripts nest tool_result blocks inside message.content[] instead of
  // carrying tool_use_id at the top level — without this, subagents started via the nested
  // Agent tool_use path (detectClaudeCalls) never get marked stopped. Synchronous agents finish
  // here; async ones were already skipped above.
  if (json.message && Array.isArray(json.message.content)) {
    for (const block of json.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        markStopped(currentSubagents, block.tool_use_id);
      }
    }
  }

  detectTaskNotificationCompletion(json, currentSubagents);
}

function isLaunchOrResumeAck(json: LogEntry): boolean {
  return isAsyncLaunchAck(json) || isSendMessageResumeAck(json);
}

function isAsyncLaunchAck(json: LogEntry): boolean {
  // Match the launch status exactly: a finished async agent may still carry isAsync on its entry.
  return json.toolUseResult?.status === 'async_launched';
}

function isSendMessageResumeAck(json: LogEntry): boolean {
  // `resumedAgentId` isn't part of LogEntry's typed `toolUseResult` shape — this fix stays scoped
  // to subagentDetector.ts, so the value is widened to unknown and narrowed locally here instead
  // of touching the shared parser type (mirrors subagentMetadata.ts's sidecar field reads).
  const result: unknown = json.toolUseResult;
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof (result as Record<string, unknown>).resumedAgentId === 'string'
  );
}

/** A backgrounded agent reports completion as a <task-notification> turn in the PARENT transcript.
 * A classic Agent-tool dispatch carries the <tool-use-id> of the tool_use that spawned it — the
 * key subagents are stored under. A forked-skill launch (forkedSkillDetector.ts) never had a
 * tool_use, so its notification carries only <task-id>, which IS the agentId it was keyed under.
 * Both are tried independently. The <tool-use-id> path is a plain map-key lookup that no-ops on a
 * miss. The <task-id> path goes through markStoppedByTaskId, which ALSO matches on `.agentId` —
 * so a classic subagent's own <task-id> can resolve too, since subagentMetadata fills `.agentId`
 * from the sidecar filename. That is correct, not a collision: it's the same agent addressed by
 * its other id. Verified against real corpus (~3GB, 317 projects): 248 files carry <task-id>, 262
 * carry <tool-use-id>, 247 carry both — <task-id> alone is exactly the forked-skill case. */
function detectTaskNotificationCompletion(json: LogEntry, currentSubagents: Map<string, SubAgent>): void {
  const text = getEntryText(json);
  if (!text.includes('<task-notification>')) {
    return;
  }
  const toolUseIdMatch = text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/);
  if (toolUseIdMatch) {
    markStopped(currentSubagents, toolUseIdMatch[1].trim());
  }
  const taskIdMatch = text.match(/<task-id>([^<]+)<\/task-id>/);
  if (taskIdMatch) {
    markStoppedByTaskId(currentSubagents, taskIdMatch[1].trim());
  }
}

/** The notification reaches the parent transcript in three shapes, and a given agent may only ever
 * get one of them: a plain user turn (message.content), a `queue-operation` entry (top-level
 * content), or a `queued_command` attachment (attachment.prompt). Read all three. */
function getEntryText(json: LogEntry): string {
  const parts: string[] = [];
  const content = json.message?.content;
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  if (typeof json.content === 'string') {
    parts.push(json.content);
  }
  if (typeof json.attachment?.prompt === 'string') {
    parts.push(json.attachment.prompt);
  }
  return parts.join('\n');
}

function markStopped(currentSubagents: Map<string, SubAgent>, id: string): void {
  const sub = currentSubagents.get(id);
  if (sub) {
    sub.status = 'stopped';
  }
}

/**
 * <task-id> is the agentId. For a subagent whose map key still equals its agentId, this is
 * exactly markStopped(). It only diverges after a SendMessage resume (reactivateSubagent)
 * re-keys the entry to the resume's own tool_use id while leaving `.agentId` untouched — a
 * plain map.get(id) would then miss, leaving the subagent stuck 'working' forever, which (via
 * sessionDedupe.applyNestedAgentLiveness) pins the whole parent session 'working' too.
 *
 * DEFENSIVE, not a fix for a reproduced failure: no transcript observed so far has actually hit
 * this path — the one real post-resume notification seen carried BOTH tags, and <tool-use-id>
 * alone already resolved it. This guards a plausible shape that just hasn't shown up yet.
 */
function markStoppedByTaskId(currentSubagents: Map<string, SubAgent>, taskId: string): void {
  if (currentSubagents.has(taskId)) {
    markStopped(currentSubagents, taskId);
    return;
  }
  const fallback = findSubagentByAgentId(currentSubagents, taskId);
  if (fallback) {
    fallback.status = 'stopped';
  }
}

/** Last (most recently launched) match wins on a reused agentId, mirroring
 * findSubagentEntryByTarget's iteration-order tie-break. */
function findSubagentByAgentId(currentSubagents: Map<string, SubAgent>, agentId: string): SubAgent | undefined {
  let found: SubAgent | undefined;
  for (const sub of currentSubagents.values()) {
    if (sub.agentId === agentId) {
      found = sub;
    }
  }
  return found;
}
