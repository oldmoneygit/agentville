import { Session, SubAgent } from './types';
import { SidecarMetadata, candidateMetadataDirs, readAllSidecars } from './sidecarReader';

/**
 * Enrich subagents from the `agent-<id>.meta.json` sidecar Claude Code writes next to each
 * subagent transcript. Three independent things can be missing and trigger a sidecar lookup: a
 * still-placeholder 'Agent' name, a missing model, or — critically — a missing `agentId` (see
 * needsSidecarData). The sidecar's `toolUseId` is the id of the launching `tool_use` block, fixed
 * forever at launch time — so the join key is `sub.launchId ?? sub.id`, not just `sub.id`: a
 * SendMessage resume (subagentDetector.ts's detectSendMessageResume) re-keys `sub.id` to its OWN
 * tool_use id and stashes the original launch id in `sub.launchId` precisely so this join keeps
 * working after a resume — without it, a resumed subagent would silently stop being enrichable.
 *
 * The sidecar filename's `<id>` is also read now (into `SidecarMetadata.agentId`) — an earlier
 * version of this comment called it "an unrelated internal agent id"; that was wrong. It is the
 * raw agentId Claude Code assigns the subagent, and the other form SendMessage's `to` can carry
 * when the launch never set an explicit `name` (see subagentDetector.ts's findSubagentEntryByTarget).
 * As of this fix it can ALSO be filled for a subagent whose launch DID set an explicit `name` —
 * see needsSidecarData — which means a class of subagent that previously could only be
 * SendMessage-resumed by name is now also addressable by agentId. Confirmed this doesn't change
 * any existing resume test: subagentDetector.test.ts builds its `currentSubagents` maps directly
 * from literal SubAgent objects and never calls into this module, so it's unaffected either way.
 *
 * Called from logParser.ts only when the session's OWN transcript grows — correct here, since
 * this only ever needs to run once per subagent, right after it's first detected (or, for
 * agentId, once its sidecar exists — see needsSidecarData for why that's usually the very next
 * parse pass, not a sustained cost). Grandchild ("subagent launched by a subagent") attachment
 * deliberately does NOT live in this function — it has the opposite requirement (its data doesn't
 * come from this transcript at all) and lives in nestedSubagents.ts's refreshNestedSubagents
 * instead, called on a completely different cadence. See that file's doc comment for why.
 */
export function enrichSubagentMetadata(session: Session): void {
  const candidates = session.subagents.filter(needsSidecarData);
  if (candidates.length === 0) {
    return;
  }

  const sidecars = readAllSidecars(candidateMetadataDirs(session), session.id);
  if (sidecars.length === 0) {
    return;
  }

  const metadataByToolUseId = indexByToolUseId(sidecars);
  for (const sub of candidates) {
    applyMetadata(sub, metadataByToolUseId.get(sub.launchId ?? sub.id));
  }
}

/**
 * A subagent still needs its sidecar consulted if it's missing a display name, a model, OR its
 * `agentId`. The first two are cosmetic — what this function used to check alone. `agentId` is
 * NOT cosmetic: it's the subagent's identity, and nestedSubagents.ts's attachNestedSubagents joins
 * grandchildren onto it via `sub.agentId ?? sub.id`.
 *
 * Before this fix, a subagent whose launch tool_use ALREADY carried an explicit `name` and
 * `model` short-circuited this check entirely (both conditions false) — and that's not an edge
 * case, it's the common one: measured 113 of 113 real classic-dispatch subagents across 3 real
 * sessions have both set at launch. So `sub.agentId` never got filled for the overwhelming
 * majority of subagents, even though their sidecar (and the toolUseId to find it by) existed the
 * whole time. Their grandchildren's sidecars carry `parentAgentId` set to the agentId Claude Code
 * assigned internally — NEVER a toolUseId — so without `sub.agentId`, attachNestedSubagents'
 * `sub.agentId ?? sub.id` fallback landed on the raw tool_use id instead, which never matches any
 * child's `parentAgentId`: every grandchild of an already-named subagent silently went missing.
 * That fallback only rescues the forked-skill case (forkedSkillDetector.ts constructs those
 * SubAgents with `id` already equal to `agentId` at detection time); classic dispatch — the far
 * more common path in the corpus (125 of 136 parentAgentId sidecars vs 11 forked-skill) — has no
 * such shortcut and depends entirely on this filter reaching the sidecar.
 *
 * Cost/convergence: adding `!sub.agentId` means a subagent with no matching sidecar (yet, or
 * ever) never satisfies this check, so it never drops out of `candidates` the way a fully
 * enriched one does — enrichSubagentMetadata's early-exit stops firing for that SESSION for as
 * long as that's true. In practice this window is short: readAllSidecars is backed by
 * sidecarReader.ts's per-directory cache (invalidated only when the directory's filename listing
 * changes), so a repeated miss costs one cheap `readdirSync` per candidate dir, not a re-read/
 * re-parse of every sidecar. Measured directly (64 sidecars, matching the real northwind-app subagent
 * count): a cold read (readdir + 64x readFile + JSON.parse) took 1.189ms; 1000 subsequent
 * cache-HIT calls against the same unchanged directory took 41.917ms total — 0.042ms/call
 * average, ~28x cheaper per call than the cold read, and negligible next to the 15s/parse cadence
 * this runs on. Once a subagent's sidecar IS read (applyMetadata sets `agentId` unconditionally
 * whenever the sidecar has one), all three conditions go false and it drops out of every future
 * candidate list — this is a one-time delay per subagent, not a permanent regression.
 */
function needsSidecarData(sub: SubAgent): boolean {
  return sub.name === 'Agent' || !sub.model || !sub.agentId;
}

function applyMetadata(sub: SubAgent, meta: SidecarMetadata | undefined): void {
  if (!meta) {
    return;
  }
  if (meta.agentType && sub.name === 'Agent') {
    sub.name = meta.agentType;
  }
  if (meta.model && !sub.model) {
    sub.model = meta.model;
  }
  // Unlike name/model above, agentId is applied whenever the sidecar has one — never gated on
  // "only if sub doesn't already have one" — because it's identity, not cosmetic enrichment:
  // this is the assignment needsSidecarData exists to guarantee actually runs (see its comment).
  if (meta.agentId) {
    sub.agentId = meta.agentId;
  }
}

/** Keyed by toolUseId; later dir wins on a duplicate id (readAllSidecars already deduplicates
 * upstream, so this is just a projection onto the toolUseId key space) — feeds the name/model
 * enrichment join above. A sidecar with no toolUseId is simply absent from this map; that's fine
 * here — it's the shape a forked-skill teammate has, and this function never needs to enrich one
 * of those by toolUseId (nestedSubagents.ts reads it via parentAgentId instead). */
function indexByToolUseId(sidecars: SidecarMetadata[]): Map<string, SidecarMetadata> {
  const result = new Map<string, SidecarMetadata>();
  for (const meta of sidecars) {
    if (meta.toolUseId) {
      result.set(meta.toolUseId, meta);
    }
  }
  return result;
}
