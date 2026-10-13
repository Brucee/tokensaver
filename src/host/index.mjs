// Host adapter registry. Adding a new harness (codex, antigravity, devin,
// pi-agent…): create src/host/<name>.mjs exporting the same surface as
// claude.mjs, register it in HOSTS below, and add a detection rule in
// detectHost. Everything outside this folder talks only to getHost() —
// the ifs live here, not scattered across the codebase.
import claude from "./claude.mjs";
import codex from "./codex.mjs";

const HOSTS = { claude, codex };

export const HOST_NAMES = Object.keys(HOSTS);

// Detection order: explicit override → host env markers → plugin-root path →
// hook-envelope signals → claude fallback. Verified on codex-cli 0.162.1:
// Codex exports CLAUDE_PLUGIN_ROOT for compatibility but neither CODEX_HOME
// nor CODEX_CLI reaches hook processes, so env alone is not enough — the
// plugin path under .codex and Codex-only envelope fields are the reliable
// signals. TOKENSAVER_HOST forces a choice (tests, debug, exotic setups).
export function detectHost(env = process.env, hookInput) {
  const forced = env.TOKENSAVER_HOST;
  if (forced && Object.hasOwn(HOSTS, forced)) return forced;
  if (env.CODEX_HOME || env.CODEX_CLI || env.CODEX_CI) return "codex";
  if (/[\\/]\.codex[\\/]/i.test(env.CLAUDE_PLUGIN_ROOT ?? "")) return "codex";
  if (hookInput && typeof hookInput === "object") {
    if (typeof hookInput.turn_id === "string") return "codex"; // Codex-only field
    const tp = String(hookInput.transcript_path ?? "");
    if (/[\\/]\.codex[\\/]/i.test(tp) || /rollout-[^\\/]*\.jsonl$/i.test(tp)) return "codex";
  }
  return "claude";
}

let cached;
let boundHost;

// A hook resolves its host once from the complete envelope. Downstream
// modules must keep that selection even when environment markers are absent.
export function bindHost(env = process.env, hookInput) {
  boundHost = HOSTS[detectHost(env, hookInput)];
  return boundHost;
}

export function getHost(env = process.env, hookInput) {
  if (boundHost && env === process.env && hookInput === undefined) return boundHost;
  const name = detectHost(env, hookInput);
  if (cached?.name === name) return cached;
  cached = HOSTS[name] ?? HOSTS.claude;
  return cached;
}

// Test helper — clear the memoized adapter.
export function _resetHost() {
  cached = undefined;
  boundHost = undefined;
}
