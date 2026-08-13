import * as fs from 'fs';
import { Session, SubAgent } from './types';
import { SidecarMetadata, candidateMetadataDirs, readAllSidecars } from './sidecarReader';
import { IDLE_CEILING, RECENT_WRITE } from './sessionActivity';

/**
 * Attaches/refreshes "grandchildren" — subagents launched BY a subagent, invisible to the
 * session transcript because they never appear there (see attachNestedSubagents for the join
 * itself). Deliberately called from sessionTreeDataProvider.ts's updateActiveStatuses() (the 15s
 * tick, and every file-change-triggered refresh) instead of from the transcript parse the way
 * subagentMetadata.ts's enrichSubagentMetadata is.
 *
 * That split matters: a backgrounded subagent writes exactly two lines to the PARENT transcript
 * — the launch ACK and, much later, its own <task-notification> (subagentDetector.ts) — with a
 * long gap between them that is exactly when it spawns and runs its own grandchildren. Gating
 * grandchild discovery on the PARENT transcript's growth (as a first version of this feature
 * did, by folding it into enrichSubagentMetadata) meant it never ran again during that whole
 * gap, so a grandchild's sidecar could sit on disk, already 'working', while the tree still
 * showed its parent as a leaf with nothing under it. What a grandchild's status actually depends
 * on — stat() on its own sidecar and sibling .jsonl — has no relationship to the parent
 * transcript's growth at all, so this reads that signal on its own cadence instead.
 *
 * Antigravity has no sidecar files at all (a completely different log format —
 * detectAntigravityCalls in subagentDetector.ts), so for an Antigravity session
 * candidateMetadataDirs resolves to a directory that simply doesn't exist; readAllSidecars
 * already returns [] for it and this whole function no-ops. No separate Antigravity branch is
 * needed (unlike detectSendMessageResume's explicit carve-out in subagentDetector.ts, which
 * exists because it mutates shared state Antigravity's own code path also touches — nothing here
 * does).
 */
export function refreshNestedSubagents(session: Session): void {
  if (session.subagents.length === 0) {
    return;
  }
  const sidecars = readAllSidecars(candidateMetadataDirs(session), session.id);
  if (sidecars.length === 0) {
    return;
  }
  attachNestedSubagents(session.subagents, sidecars);
}

/**
 * Attaches "grandchildren" to their launching subagent, one level deep only. A parent's own
 * agentId is `sub.agentId` once enriched, OR — for the subagent THAT WAS a forked-skill launch
 * itself — `sub.id` (detectForkedSkillLaunch sets `id === agentId` at detection time, no separate
 * `.agentId` ever gets assigned to it). Both forms are checked so the join works for either
 * shape of parent.
 *
 * Deliberately ONE level: a sidecar whose parentAgentId points at a subagent that is ITSELF a
 * just-attached grandchild (a depth-3 chain — real but rare, 5 of 5007 sidecars in the corpus
 * this was verified against) is left unattached. This falls out naturally from only matching
 * against `subs` (the level-1 list) and never recursing into the `.children` just assigned.
 */
function attachNestedSubagents(subs: SubAgent[], sidecars: SidecarMetadata[]): void {
  const childrenByParentId = groupByParentAgentId(sidecars);
  if (childrenByParentId.size === 0) {
    return;
  }
  for (const sub of subs) {
    const ownAgentId = sub.agentId ?? sub.id;
    const children = childrenByParentId.get(ownAgentId);
    if (children) {
      sub.children = children.map(toChildSubAgent);
    }
  }
}

/** Groups sidecars that carry a parentAgentId by that id (the input already went through
 * readAllSidecars' dedupeSidecars, so no identity collision handling is needed here). A sidecar
 * whose parentAgentId matches no subagent currently known is simply never looked up by
 * attachNestedSubagents — never thrown on, never turned into a phantom parent. */
function groupByParentAgentId(sidecars: SidecarMetadata[]): Map<string, SidecarMetadata[]> {
  const result = new Map<string, SidecarMetadata[]>();
  for (const meta of sidecars) {
    if (!meta.parentAgentId) {
      continue;
    }
    const siblings = result.get(meta.parentAgentId) ?? [];
    siblings.push(meta);
    result.set(meta.parentAgentId, siblings);
  }
  return result;
}

/** Builds a grandchild SubAgent straight from its sidecar — unlike a level-1 subagent, there is
 * no tool_use block to detect it from (its launch happened inside the PARENT's own transcript,
 * which this extension deliberately never reads), so every field comes from the sidecar alone.
 * Status is computed HERE, at build time, never cached — see computeChildStatus. Falls back to a
 * random id in the (essentially never hit) case where the filename didn't match the expected
 * agent-<id>.meta.json shape. */
function toChildSubAgent(meta: SidecarMetadata): SubAgent {
  return {
    id: meta.agentId ?? meta.toolUseId ?? Math.random().toString(),
    agentId: meta.agentId,
    name: meta.agentType ?? 'Agent',
    task: meta.description ?? 'Delegate task',
    status: computeChildStatus(meta),
    model: meta.model,
  };
}

/**
 * Best-effort status for a grandchild: levels 1-2 (the session's own subagents) read
 * lastEntryType/lastEntryIsThinking off a fully parsed transcript (sessionActivity.ts's
 * computeSessionStatus); a grandchild has no such parse — reading its own 320-940KB transcript
 * just to get a status was evaluated and rejected as expensive for no real gain. So this is
 * ENTIRELY mtime-based, and computed FRESH on every call (never cached alongside the rest of a
 * SidecarMetadata — see sidecarReader.ts's directory cache — or it would go stale between cache
 * refreshes).
 *
 * When the sibling `agent-<id>.jsonl` exists, its mtime is compared against IDLE_CEILING (30
 * min) — NOT the much shorter RECENT_WRITE (60s). A genuinely working grandchild can go minutes
 * between transcript writes, exactly like a session can (sessionActivity.ts's own doc comment on
 * computeSessionStatus makes the same point) — and unlike a session, a grandchild has no other
 * signal (no awaitingReply/isThinking/hasRunningAgents) to lean on while that gap is open, so it
 * needs the MORE generous ceiling, not the tighter one. Using RECENT_WRITE here made an actually
 * still-working grandchild flicker to 'stopped' on every refresh between writes.
 *
 * When the .jsonl doesn't exist yet, this used to default to 'working' unconditionally — but that
 * left a permanently orphaned sidecar (the child died before ever writing its transcript: API
 * error, kill, invalid model) reading as 'working' forever, the exact class of bug the IDLE_CEILING
 * change above just fixed at the session level. So this fallback is bounded by the SIDECAR's OWN
 * mtime instead: within RECENT_WRITE of the sidecar being written, 'working' (most likely just
 * launched, transcript not flushed yet); past that with still no transcript, 'stopped'.
 */
function computeChildStatus(meta: SidecarMetadata): 'working' | 'stopped' {
  const jsonlPath = meta.sidecarPath.replace(/\.meta\.json$/, '.jsonl');
  try {
    const jsonlStats = fs.statSync(jsonlPath);
    return Date.now() - jsonlStats.mtimeMs < IDLE_CEILING ? 'working' : 'stopped';
  } catch {
    try {
      const sidecarStats = fs.statSync(meta.sidecarPath);
      return Date.now() - sidecarStats.mtimeMs < RECENT_WRITE ? 'working' : 'stopped';
    } catch {
      return 'stopped'; // Sidecar itself unreadable — nothing left to base 'working' on.
    }
  }
}
