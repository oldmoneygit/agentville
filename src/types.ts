export interface SubAgent {
  id: string;
  name: string;
  task: string;
  status: 'working' | 'stopped';
  model?: string; // LLM the subagent runs on (from the Agent tool's `model` input)
  launchId?: string; // Original launch tool_use id, preserved when a SendMessage resume re-keys `id` (subagentDetector.ts) so subagentMetadata's sidecar join keeps matching
  agentId?: string; // Raw agentId from the sidecar filename (agent-<id>.meta.json) — the other form SendMessage's `to` may target when launch set no `name` (subagentMetadata.ts)
  // "Grandchildren": subagents THIS subagent launched itself (joined on the sidecar's
  // parentAgentId — see subagentMetadata.ts's attachNestedSubagents). Deliberately one level
  // only — a depth-3 chain (a grandchild's own children) is truncated, not represented here.
  children?: SubAgent[];
}

export interface Session {
  id: string; // The session UUID or Conversation ID
  projectHash: string; // Raw project-hash directory name or ID
  projectPath: string; // Resolved project absolute path
  projectName: string; // Human-readable project folder name or user prompt
  gitBranch: string;
  status: 'working' | 'stopped';
  lastInteractionTime: number; // Unix timestamp in ms
  subagents: SubAgent[];
  logFilePath: string;
  type: 'claude-code' | 'antigravity';
  nameFromPrompt?: boolean; // Flag indicating if sessionTitle was captured
  sessionTitle?: string; // First user prompt (session name as shown in Claude/AG tab)
  titleIsCustom?: boolean; // sessionTitle came from a user rename — nothing generated may override it
  model?: string; // LLM the session runs on (from assistant `message.model`)
  isSidechain?: boolean; // True if this transcript is a subagent sidechain, not a standalone session
  lastEntryType?: string; // `type` of the last transcript entry — 'user' means Claude still owes a reply
  lastEntryIsThinking?: boolean; // Last conversational turn was a thinking-only block — mid-turn, still working
  lastEntryIsInterruption?: boolean; // Last user turn was Claude Code's own interruption sentinel (Esc), not a real prompt — overrides the 'user' reading of lastEntryType above. Recomputed on every message-bearing turn like lastEntryType, so it self-clears the moment a genuine next turn lands.
  entrypoint?: string; // How the session started: 'claude-vscode'/'cli' = human, 'sdk-*' = spawned agent
  claudeVersion?: string; // Claude Code version stamped on the transcript (`version` field), for compat checks
  worktreeName?: string; // Bare git-worktree name from the last `type:"worktree-state"` entry seen — lets
  // nameExtractor.extractRenamedTitle recognize Claude Code's own auto-stamped `custom-title` (set to this
  // same name on worktree entry) instead of trusting it as a real user rename.
}
