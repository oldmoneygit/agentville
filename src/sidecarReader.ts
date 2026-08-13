import * as fs from 'fs';
import * as path from 'path';
import { Session } from './types';
import { logDebug } from './logger';

/**
 * Raw content of one `agent-<id>.meta.json` sidecar, plus its own path. Shared by
 * subagentMetadata.ts (name/model enrichment, keyed by toolUseId) and nestedSubagents.ts
 * (grandchild attachment, keyed by parentAgentId) — this module only reads and caches sidecars
 * off disk; it has no opinion on what either caller does with them.
 */
export interface SidecarMetadata {
  agentType?: string;
  model?: string;
  toolUseId?: string;
  agentId?: string;
  parentAgentId?: string; // Set when this subagent was launched BY another subagent, not by the
  // session itself — the join key nestedSubagents.ts groups grandchildren by.
  description?: string; // A grandchild's task text (nestedSubagents.ts) — level-1 subagents get
  // `task` from the launching tool_use block instead (subagentDetector.ts); a grandchild has no
  // such block, so this sidecar field is its ONLY source of task text.
  sidecarPath: string; // Absolute path to this agent-<id>.meta.json itself. Kept (not just the
  // parsed content) so nestedSubagents.ts's computeChildStatus can derive a grandchild's status
  // FRESH at build time via a live stat() on every call — status must never be baked into the
  // cached parse result below, or it would go stale between cache refreshes.
}

/**
 * Claude Code encodes a project cwd into a projects-dir name by replacing every character that
 * isn't [A-Za-z0-9] with '-' (see projectPathResolver.ts's decode comment, and the identical
 * regex logParser.projectPath.test.ts uses to build its fixtures). Verified against real
 * ~/.claude/projects directory names, including ones with dots, underscores and mixed case:
 * uppercase letters pass through unchanged, and '.', '_', '/' all collapse to '-' individually
 * (no run-length collapsing — "/.claude/" produces "--claude-", a real double-dash on disk).
 * Encoding is unambiguous (unlike decoding, which is a best-effort guess), so a plain regex
 * replace is all that's needed here — nothing to reuse from decodeClaudeProjectPath's
 * filesystem-probing disambiguation, which solves the opposite, ambiguous direction.
 */
function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * A session that entered a git worktree keeps its MAIN transcript in the base project's
 * ~/.claude/projects/<encoded-base> directory, while its subagent sidecars land under the
 * WORKTREE's own encoded directory (subagents run with the worktree as their real cwd, unlike
 * the parent transcript's fixed location). So sidecars must be looked up in BOTH: the directory
 * the main transcript itself lives in (from session.logFilePath), and the directory
 * session.projectPath currently encodes to (the last cwd seen on this transcript, which may be
 * the worktree, or may be the base — it can flip over a session's lifetime). Never assume either
 * alone is enough. Order matters for readAllSidecars' "later dir wins" dedup.
 */
export function candidateMetadataDirs(session: Session): string[] {
  const baseDir = path.dirname(session.logFilePath);
  if (!session.projectPath) {
    return [baseDir];
  }
  const claudeProjectsPath = path.dirname(baseDir);
  const projectPathDir = path.join(claudeProjectsPath, encodeProjectDir(session.projectPath));
  return projectPathDir === baseDir ? [baseDir] : [baseDir, projectPathDir];
}

/** Reads every sidecar under `<dir>/<sessionId>/subagents/` across all candidate dirs, in dir
 * order, then deduplicates (see dedupeSidecars). Nothing is discarded by toolUseId presence: a
 * forked-skill teammate sidecar (detectForkedSkillLaunch) carries no toolUseId at all, but DOES
 * carry parentAgentId when it's a grandchild — dropping it would make grandchildren unrecoverable. */
export function readAllSidecars(dirs: string[], sessionId: string): SidecarMetadata[] {
  const metas: SidecarMetadata[] = [];
  for (const dir of dirs) {
    const subagentsDir = path.join(dir, sessionId, 'subagents');
    metas.push(...readSidecarsInDirCached(subagentsDir));
  }
  return dedupeSidecars(metas);
}

/** Deduplicates sidecars that represent the SAME underlying subagent, read from two candidate
 * directories (a worktree session splits sidecars across the base and worktree dirs, and a rare
 * id collision between them is real, not hypothetical — candidateMetadataDirs' doc comment
 * already calls it out). Later directory wins, matching that same determinism guarantee; without
 * this, a sidecar present in both dirs rendered twice downstream (e.g. as a duplicate
 * grandchild). Keyed by toolUseId when present, else by the filename-derived agentId — the only
 * identity a toolUseId-less forked-skill teammate has. */
function dedupeSidecars(sidecars: SidecarMetadata[]): SidecarMetadata[] {
  const byIdentity = new Map<string, SidecarMetadata>();
  for (const meta of sidecars) {
    const identity = meta.toolUseId ?? meta.agentId;
    if (identity) {
      byIdentity.set(identity, meta);
    }
  }
  return [...byIdentity.values()];
}

// Cache of parsed sidecar CONTENT (never a derived status — see nestedSubagents.ts's
// computeChildStatus) per subagents/ directory, keyed by its absolute path. Invalidated by
// comparing the current *.meta.json filename listing against the one last seen — sidecars are
// written once at launch and never rewritten afterward (no evidence anywhere in this codebase of
// Claude Code touching one again post-creation), so "same filenames as last time" is a safe,
// cheap proxy for "same content as last time", and avoids a directory-mtime comparison whose
// resolution on some filesystems can be too coarse to reliably detect two changes landing in the
// same tick. Needed because nestedSubagents.ts's refreshNestedSubagents now runs on every 15s
// tick (and every file-change refresh) for every session with subagents, not just when a
// transcript happens to grow — without this, that re-reads and re-JSON.parses every sidecar every
// time, even for sessions where nothing changed. Module-level and never evicted: the number of
// distinct subagents/ directories across a user's open sessions is small and bounded, and each
// entry holds only a handful of tiny (~350B) parsed objects — the same read-avoidance goal
// LogParser's per-file byte-offset cache serves for transcripts, just keyed by directory instead.
const sidecarDirCache = new Map<string, { fileNames: string[]; metas: SidecarMetadata[] }>();

function readSidecarsInDirCached(subagentsDir: string): SidecarMetadata[] {
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(subagentsDir).filter((entry) => entry.endsWith('.meta.json'));
  } catch {
    // Missing directory (no worktree, or no subagents yet) is the common case, not an error.
    // Drop any stale entry so a later real directory at this path is never compared against it.
    sidecarDirCache.delete(subagentsDir);
    return [];
  }

  const cached = sidecarDirCache.get(subagentsDir);
  if (cached && sameFileNames(cached.fileNames, fileNames)) {
    return cached.metas;
  }

  const metas: SidecarMetadata[] = [];
  for (const fileName of fileNames) {
    const meta = readSidecarFile(path.join(subagentsDir, fileName));
    if (meta) {
      metas.push(meta);
    }
  }
  sidecarDirCache.set(subagentsDir, { fileNames, metas });
  return metas;
}

/** Order-independent (readdirSync order isn't guaranteed stable) equality check on two filename
 * lists. */
function sameFileNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a);
  return b.every((name) => setA.has(name));
}

function readSidecarFile(filePath: string): SidecarMetadata | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    // The sidecar format is undocumented and unversioned, so field TYPES can't be assumed either:
    // a non-string agentType would flow straight into a TreeItem label and render as
    // "[object Object]". Keep only string values and drop anything else.
    const fields = parsed as Record<string, unknown>;
    return {
      agentType: typeof fields.agentType === 'string' ? fields.agentType : undefined,
      model: typeof fields.model === 'string' ? fields.model : undefined,
      toolUseId: typeof fields.toolUseId === 'string' ? fields.toolUseId : undefined,
      agentId: extractAgentIdFromFilename(path.basename(filePath)),
      parentAgentId: typeof fields.parentAgentId === 'string' ? fields.parentAgentId : undefined,
      description: typeof fields.description === 'string' ? fields.description : undefined,
      sidecarPath: filePath,
    };
  } catch (err) {
    logDebug(`sidecarReader: failed to read sidecar ${filePath}: ${String(err)}`);
    return null;
  }
}

/**
 * The sidecar filename is `agent-<id>.meta.json`; `<id>` is the raw agentId Claude Code assigns
 * the subagent internally. Confirmed against real sidecars from one session: only 2 of 4 launches
 * passed `name` in the Agent tool's input — the other 2 are only addressable by this id, which is
 * exactly the form SendMessage's `to` carries for them (see subagentDetector.ts's
 * findSubagentEntryByTarget).
 */
function extractAgentIdFromFilename(fileName: string): string | undefined {
  return fileName.match(/^agent-(.+)\.meta\.json$/)?.[1];
}
