// Claude Code host adapter — the reference implementation.
// Normalization is identity: the plugin was born on Claude, so the internal
// canonical hook shape IS Claude's envelope. New harnesses must produce the
// same canonical shape from their own envelope.
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "claude";

export function homeDir() {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "tokensaver");
}

// Pre-1.0.5 state lived here; migrated by config.tokensaverHome().
export function legacyHome() {
  return join(homedir(), ".tokensaver");
}

// Canonical shape = the Claude hook envelope itself.
export function normalizeHookInput(raw) {
  return raw;
}

// Host-scoped settings file: on Claude our keys live inside the shared
// ~/.claude/settings.json (tokensaver.sql, statusLine registration, ...).
export function hostSettingsFile() {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

// Native tool names as they appear in tool_name / permission decisions.
export const toolNames = {
  mcpPrefix: "mcp__plugin_tokensaver_code__",
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  notebookEdit: "NotebookEdit",
  grep: "Grep",
  glob: "Glob",
  task: "Task",
  exploreAgent: "Explore",
};

export const capabilities = {
  hostSettings: true,      // can write ~/.claude/settings.json safely
  statusLine: true,        // custom statusline in ~/.claude/settings.json
  toolRedirect: true,      // PreToolUse nudges Bash→Search/Edit/Sql
  nativeAgents: true,      // agents/*.md with model pinning (haiku)
  subagentFanout: true,    // Task tool → parallel single-lens reviewers
  transcriptSessions: true,// ~/.claude/projects/**/*.jsonl readable
  sessionTitle: true,      // UserPromptSubmit sessionTitle output contract
  postCompactDigest: true, // PreCompact/PostCompact + preservedMessages
  router: true,            // ANTHROPIC_BASE_URL loopback daemon
};

export default { name, homeDir, legacyHome, normalizeHookInput, hostSettingsFile, toolNames, capabilities };
