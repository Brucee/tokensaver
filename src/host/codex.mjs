// Codex CLI host adapter — verified against codex-cli 0.162.1 (2026-10-13).
// Codex emits a Claude-compatible hook envelope by design: same snake_case
// fields, tool_name "Bash" for shell calls, same hookSpecificOutput output
// contract (additionalContext, permissionDecision, updatedInput).
// Rollout transcript scanning (savings accounting) is implemented via
// scanCodexTranscriptDelta; the post-compaction digest analyzer reads
// "compacted".replacement_history; spawn_agent fan-out verified live
// (collaboration namespace, model pinning works, children see our MCP tools).
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "codex";

export function homeDir() {
  return join(homedir(), ".codex", "tokensaver");
}

export function legacyHome() {
  return null; // no legacy dir to migrate on this host
}

// Codex has no shared JSON settings surface for plugins — host-scoped
// settings (e.g. the Sql policy) get our own file under the plugin home.
export function hostSettingsFile() {
  return join(homeDir(), "host-settings.json");
}

// Codex already emits the canonical (Claude-shaped) envelope — identity,
// with a tolerant shim for a camelCase variant seen in older builds.
export function normalizeHookInput(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const event = raw.hook_event_name ?? raw.hookEventName;
  return { ...raw, hook_event_name: event };
}

// Verified on codex-cli 0.162.1 hook dumps:
//   tool_name "Bash" for exec_command/shell (tool_input.command),
//   "apply_patch" for file edits, "spawn_agent" for subagents (matcher
//   also accepts the "Agent" alias), mcp__<server>__<tool> for MCP.
// Codex has no separate Read/Grep/Glob builtins — file ops go through Bash,
// so the shell-command matchers do the redirect work there too.
export const toolNames = {
  mcpPrefix: "mcp__code__", // our MCP server registers as "code"
  bash: "Bash",
  read: "Bash",
  edit: "apply_patch",
  write: "apply_patch",
  notebookEdit: "apply_patch",
  grep: "Bash",
  glob: "Bash",
  task: "spawn_agent",
  exploreAgent: "spawn_agent",
};

export const capabilities = {
  hostSettings: false,     // Codex config.toml layout not mapped yet
  statusLine: false,       // Codex has its own TUI — no custom statusline hook
  toolRedirect: true,      // verified live: envelope + additionalContext work
  nativeAgents: false,     // agents/*.md frontmatter is Claude-specific
  subagentFanout: true,    // spawn_agent verified: parallel, model:"gpt-6-luna" pin works, children inherit MCP
  transcriptSessions: true,// rollout parser live (token_usage_record + response_item)
  sessionTitle: false,     // sessionTitle is a Claude-only hook output field
  postCompactDigest: true, // "compacted".replacement_history = preserved items
  router: false,           // Codex has native model_provider — pointless
};

export default { name, homeDir, legacyHome, normalizeHookInput, hostSettingsFile, toolNames, capabilities };
