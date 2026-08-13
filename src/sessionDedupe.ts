import * as path from 'path';
import { Session, SubAgent } from './types';

/** A session launched via the SDK (entrypoint 'sdk*') is a background agent (e.g. /security-review,
 * a workflow run), not a human IDE session. */
export function isAgentSession(session: Session): boolean {
  return session.entrypoint?.startsWith('sdk') ?? false;
}

// How far apart a background agent and its launcher may be (by last-activity) and still be linked.
// The transcript carries no child→parent id, so proximity + same cwd/branch is the best signal.
const PARENT_WINDOW_MS = 15 * 60 * 1000;

/** Find the human session that most likely launched this background agent: same project + branch,
 * and either still working or last active within PARENT_WINDOW_MS of the agent. Returns null when
 * nothing matches — the caller then keeps the agent as its own top-level row so it's never lost. */
export function findParentSession(agent: Session, humans: Session[]): Session | null {
  const agentCwd = path.normalize(agent.projectPath).toLowerCase();
  let best: Session | null = null;
  for (const h of humans) {
    if (h.type !== agent.type) continue;
    if (h.gitBranch !== agent.gitBranch) continue;
    if (path.normalize(h.projectPath).toLowerCase() !== agentCwd) continue;
    const near = Math.abs(agent.lastInteractionTime - h.lastInteractionTime) <= PARENT_WINDOW_MS;
    if (!near && h.status !== 'working') continue;
    if (!best || isMoreRelevant(h, best)) best = h;
  }
  return best;
}

/** Promote a human session to 'working' when a background agent it launched (matched via
 * findParentSession) is still working. computeSessionStatus only sees same-file subagents
 * (session.subagents); a cross-file nested agent's liveness never reaches it otherwise, so the
 * parent can render 'stopped' while its own "Working Agents" group shows that same agent live.
 *
 * Matches are collected before any status is mutated: findParentSession's fallback keeps a
 * human eligible when it's outside PARENT_WINDOW_MS but already 'working' (the `near` check
 * above), so promoting a parent mid-loop could make it newly eligible for a later, unrelated
 * agent and change the outcome by iteration order. Two passes keep every match decision based
 * on the original statuses, so the result is order-independent. */
export function applyNestedAgentLiveness(sessions: Session[]): void {
  // Subagent transcripts stamp the parent's own entrypoint (not 'sdk*'), so isAgentSession alone
  // doesn't filter them out; exclude isSidechain too or one could impersonate a real parent.
  const humans = sessions.filter((s) => !isAgentSession(s) && !s.isSidechain);
  const parentsToPromote = new Set<Session>();
  for (const agent of sessions) {
    if (!isAgentSession(agent) || agent.status !== 'working') continue;
    const parent = findParentSession(agent, humans);
    if (parent) parentsToPromote.add(parent);
  }
  for (const parent of parentsToPromote) {
    parent.status = 'working';
  }
}

/** Render a background-agent session as a subagent row under its launcher.
 *
 * `name` is always the generic 'Agent' placeholder, never `agent.sessionTitle`: unlike a
 * Task-tool subagent (which carries a real `name`/`description` pair from its launch block) or
 * a nested subagent with a `.meta.json` sidecar (`agentType`/`description`), a background-agent
 * *session* has no field distinct from its own title — nameExtractor derives that title from the
 * same prompt `task` already shows. Using it for `name` too just repeats the task text as both
 * the row's bold label and its description, which reads as a rendering bug rather than two
 * pieces of information. 'Agent' matches subagentDetector's own fallback for the same "no real
 * name available" case, so both subagent flavors degrade to the same generic label. */
export function sessionAsSubagent(agent: Session): SubAgent {
  return {
    id: agent.id,
    name: 'Agent',
    task: agent.sessionTitle || agent.id,
    status: agent.status,
    model: agent.model,
  };
}

/** Normalize free text (session title/prompt) into a stable dedupe-key fragment: strips
 * accents, emojis and symbols, and collapses whitespace, so visually-different text never
 * collides on the raw string and near-identical text (just accents/casing) still merges. */
export function normalizeForKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diacritics
    .replace(/\p{Extended_Pictographic}/gu, '') // emoji
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Dedupe key for a session: type + projectPath + branch + title/id. The title/text component
 * keeps two genuinely concurrent sessions on the same project+branch (e.g. two Claude Code
 * windows open on the same repo) from colliding into a single slot. Sessions without a captured
 * title yet fall back to their own id, so two fresh title-less sessions don't merge either. */
export function getDedupeKey(session: Session): string {
  const projectKey = path.normalize(session.projectPath).toLowerCase();
  const textKey = normalizeForKey(session.sessionTitle || session.id);
  return `${session.type}|${projectKey}|${session.gitBranch}|${textKey}`;
}

/** Deterministic "which session wins the slot" order. Must be stable so it never oscillates. */
export function isMoreRelevant(a: Session, b: Session): boolean {
  if ((a.status === 'working') !== (b.status === 'working')) return a.status === 'working';
  // Prefer the session actually running agents, so it doesn't lose the slot to an idle sibling.
  // Count only *working* subagents: a stale predecessor (e.g. a compacted session) can carry dozens
  // of finished subagents, and total count would let it mask the recent live continuation on the
  // same branch during an idle gap. Ties then fall through to most-recent activity.
  const aWorking = a.subagents.filter((s) => s.status === 'working').length;
  const bWorking = b.subagents.filter((s) => s.status === 'working').length;
  if (aWorking !== bWorking) return aWorking > bWorking;
  if (a.lastInteractionTime !== b.lastInteractionTime) return a.lastInteractionTime > b.lastInteractionTime;
  return a.id > b.id; // final stable tiebreak
}

/** Set `candidate` at `key`, but never let a less relevant session overwrite one already
 * there. A session id can collide across two files — Claude Code's native worktree-entry
 * can leave a same-id stub transcript in the base project dir while the real transcript
 * continues under the worktree's own dir — so the caller's scan order must not decide the
 * winner the way a plain `map.set(key, candidate)` would.
 *
 * Two cases isMoreRelevant alone can't resolve, because this map is always keyed by session
 * id and every entry was inserted under its own id — so existing.id === key === candidate.id
 * on every call, which makes isMoreRelevant's final `a.id > b.id` tiebreak a no-op (`x > x`
 * is always false):
 *
 * 1. Same file, fresher parse. logParser.ts's shrink/rebuild path (file truncated then
 *    rewritten, e.g. after /clear or compaction) hands back a brand-new Session object for a
 *    file it just re-read from scratch — freshly parsed, so still 'stopped' with no
 *    subagents until computeSessionStatus classifies it. That candidate isn't a rival for the
 *    slot, it's newer data for the exact same session, so a same logFilePath always wins
 *    unconditionally, skipping the relevance comparison entirely.
 * 2. A genuine cross-file collision where isMoreRelevant ties in both directions (status,
 *    working-subagent count and lastInteractionTime all equal — plausible when a worktree
 *    stub and its real transcript are written within the same mtime tick). Broken by the one
 *    thing that still differs and is independent of scan order: the files' own paths.
 */
export function upsertIfMoreRelevant(map: Map<string, Session>, key: string, candidate: Session): void {
  const existing = map.get(key);
  if (!existing || existing.logFilePath === candidate.logFilePath) {
    map.set(key, candidate);
    return;
  }
  if (isMoreRelevant(candidate, existing)) {
    map.set(key, candidate);
    return;
  }
  if (!isMoreRelevant(existing, candidate) && candidate.logFilePath > existing.logFilePath) {
    map.set(key, candidate);
  }
}
