import * as vscode from 'vscode';
import { Session, SubAgent } from './types';

/** Shorten model ids for display: "claude-sonnet-5" → "sonnet-5"; "sonnet" stays "sonnet". */
function formatModel(model?: string): string {
  return model ? model.replace(/^claude-/, '') : '';
}

/** Non-selectable placeholder row for loading / empty states. */
export class MessageTreeItem extends vscode.TreeItem {
  constructor(label: string, iconId: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'message';
    this.iconPath = new vscode.ThemeIcon(iconId);
    if (description) {
      this.description = description;
    }
  }
}

export class BrandTreeItem extends vscode.TreeItem {
  constructor(
    public readonly brand: 'claude-code' | 'antigravity',
    public readonly sessions: Session[],
  ) {
    super(brand === 'claude-code' ? 'Claude Code' : 'Google Antigravity', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'brand';
    this.id = brand;

    if (brand === 'claude-code') {
      this.iconPath = new vscode.ThemeIcon('hubot', new vscode.ThemeColor('charts.red'));
    } else {
      this.iconPath = new vscode.ThemeIcon('run-all', new vscode.ThemeColor('charts.blue'));
    }
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: Session) {
    super(session.projectName, vscode.TreeItemCollapsibleState.Expanded);

    this.contextValue = 'session';
    this.id = session.id;

    // A session launched via the SDK (entrypoint 'sdk*') is a background agent (e.g. /security-review,
    // a workflow run), not a human IDE session. Mark it so it isn't mistaken for a duplicate session —
    // it legitimately runs its own model, often different from the launcher's.
    const isAgentSession = session.entrypoint?.startsWith('sdk') ?? false;

    // A subagent writes to its own file, so the parent transcript's clock freezes while it
    // works — a stale "Xm ago" next to a live spinner misreads as stalled, so show "working" instead.
    const relativeTime =
      session.status === 'working' ? 'working' : this.formatRelativeTime(session.lastInteractionTime);
    const model = formatModel(session.model);
    const agentTag = isAgentSession ? 'agent · ' : '';
    const meta = model
      ? `${agentTag}${model} · [${session.gitBranch}] · ${relativeTime}`
      : `${agentTag}[${session.gitBranch}] · ${relativeTime}`;
    this.description = session.sessionTitle ? `${meta}  —  ${session.sessionTitle}` : meta;

    this.tooltip = new vscode.MarkdownString(
      `**Project:** ${session.projectName}\n\n` +
        (session.sessionTitle ? `**Session:** ${session.sessionTitle}\n\n` : '') +
        `**Type:** ${session.type === 'claude-code' ? 'Claude Code' : 'Google Antigravity'}\n\n` +
        (model ? `**Model:** \`${model}\`\n\n` : '') +
        `**Branch:** \`${session.gitBranch}\`\n\n` +
        `**Last Active:** ${new Date(session.lastInteractionTime).toLocaleString()}\n\n` +
        `**Log Path:** \`${session.logFilePath}\``,
    );

    this.iconPath = this.statusIcon(session.status, isAgentSession);
  }

  private statusIcon(status: Session['status'], isAgentSession: boolean): vscode.ThemeIcon {
    if (status === 'working') {
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('testing.iconPassed'));
    }
    const idle = new vscode.ThemeColor('descriptionForeground');
    return new vscode.ThemeIcon(isAgentSession ? 'hubot' : 'circle-filled', idle);
  }

  private formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 5000) {
      return 'just now';
    }
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) {
      return `${seconds}s ago`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}

export class SubAgentGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly groupType: 'working' | 'completed',
    public readonly subagents: SubAgent[],
    public readonly parentSession: Session,
  ) {
    super(
      groupType === 'working' ? 'Working Agents' : 'Completed Agents',
      groupType === 'working' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = 'subagent-group';
    this.id = `${parentSession.id}-${groupType}`;

    if (groupType === 'working') {
      this.iconPath = new vscode.ThemeIcon('play', new vscode.ThemeColor('testing.iconPassed'));
    } else {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('descriptionForeground'));
    }
  }
}

export class SubAgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly subagent: SubAgent,
    public readonly parentSession: Session,
  ) {
    // Collapsible only when this subagent has its own nested subagents ("grandchildren" —
    // subagentMetadata.ts's attachNestedSubagents). A grandchild SubAgent never has `.children`
    // itself (nesting is truncated to one level), so this naturally renders as a leaf again for it.
    const hasChildren = (subagent.children?.length ?? 0) > 0;
    super(
      `🤖 ${subagent.name}`,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );

    this.contextValue = 'subagent';
    // Subagent's own model, falling back to the session model when it inherits it.
    const model = formatModel(subagent.model || parentSession.model);
    this.description = model ? `${model} · ${subagent.task}` : subagent.task;
    this.tooltip = `Subagent ${subagent.name}\nTask: ${subagent.task}${model ? `\nModel: ${model}` : ''}`;

    if (subagent.status === 'working' && parentSession.status === 'working') {
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('testing.iconPassed'));
    } else {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('descriptionForeground'));
    }
  }
}
