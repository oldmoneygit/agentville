import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from './logger';

export interface LogFileRef {
  path: string;
  type: 'claude-code' | 'antigravity';
}

/** Discover every Claude Code and Antigravity log file on disk. Never throws. */
export function scanSessionFiles(claudeProjectsPath: string, geminiBrainPath: string): LogFileRef[] {
  const files: LogFileRef[] = [];
  scanClaudeSessions(claudeProjectsPath, files);
  scanGeminiSessions(geminiBrainPath, files);
  return files;
}

function scanClaudeSessions(claudeProjectsPath: string, files: LogFileRef[]): void {
  if (!fs.existsSync(claudeProjectsPath)) {
    return;
  }
  try {
    const projects = fs.readdirSync(claudeProjectsPath);
    for (const project of projects) {
      const projectPath = path.join(claudeProjectsPath, project);
      scanClaudeRootSessions(projectPath, files);
      scanClaudeSubSessions(projectPath, files);
    }
  } catch (err) {
    logDebug(`sessionScanner: scanClaudeSessions() failed: ${String(err)}`);
  }
}

function scanClaudeRootSessions(projectPath: string, files: LogFileRef[]): void {
  try {
    const projectFiles = fs.readdirSync(projectPath);
    for (const file of projectFiles) {
      if (file.endsWith('.jsonl')) {
        files.push({ path: path.join(projectPath, file), type: 'claude-code' });
      }
    }
  } catch {
    // Ignore project file scan issues
  }
}

function scanClaudeSubSessions(projectPath: string, files: LogFileRef[]): void {
  const sessionsDir = path.join(projectPath, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    return;
  }
  try {
    const sessionFiles = fs.readdirSync(sessionsDir);
    for (const file of sessionFiles) {
      if (file.endsWith('.jsonl')) {
        files.push({ path: path.join(sessionsDir, file), type: 'claude-code' });
      }
    }
  } catch {
    // Ignore nested sessions scan issues
  }
}

function scanGeminiSessions(geminiBrainPath: string, files: LogFileRef[]): void {
  if (!fs.existsSync(geminiBrainPath)) {
    return;
  }
  try {
    const convs = fs.readdirSync(geminiBrainPath);
    for (const conv of convs) {
      const transcriptPath = path.join(geminiBrainPath, conv, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(transcriptPath)) {
        files.push({ path: transcriptPath, type: 'antigravity' });
      }
    }
  } catch (err) {
    logDebug(`sessionScanner: scanGeminiSessions() failed: ${String(err)}`);
  }
}
