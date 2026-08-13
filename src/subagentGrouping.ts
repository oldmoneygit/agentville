import { Session, SubAgent } from './types';

/**
 * Splits a session's subagents into Working / Completed groups for the tree's two subagent
 * folders (sessionTreeDataProvider.ts's getChildren(), level 3). Each subagent is bucketed
 * purely by ITS OWN tracked status — the parent session's overall status must never override
 * that: a session can read 'stopped' between transcript writes (sessionActivity.ts's
 * computeSessionStatus, gated on a 60s-recent-write / 30min-idle window) while a subagent it
 * dispatched, tracked independently via subagentDetector.ts, is still genuinely running. Before
 * this function existed, the session's OWN subagents were gated on `session.status === 'working'`
 * — silently dumping every one of them into "Completed Agents" the instant the parent read
 * 'stopped', even one whose own status was still 'working'.
 *
 * `nestedAgents` are cross-file background-agent sessions folded under this launcher
 * (sessionDedupe.findParentSession, via sessionAssembly.assembleVisibleSessions) — they carry
 * their own status already and were never gated on the parent's, so they're merged in here the
 * same way they always were.
 */
export function splitSubagentsByStatus(
  session: Session,
  nestedAgents: SubAgent[],
): { working: SubAgent[]; completed: SubAgent[] } {
  const ownWorking = session.subagents.filter((sub) => sub.status === 'working');
  const ownCompleted = session.subagents.filter((sub) => sub.status === 'stopped');
  return {
    working: [...ownWorking, ...nestedAgents.filter((sub) => sub.status === 'working')],
    completed: [...ownCompleted, ...nestedAgents.filter((sub) => sub.status === 'stopped')],
  };
}
