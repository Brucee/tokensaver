// Host adapter layer: detection, adapter contract, capability gates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHost, getHost, HOST_NAMES, _resetHost } from "../src/host/index.mjs";
import claude from "../src/host/claude.mjs";
import codex from "../src/host/codex.mjs";

test("detectHost: defaults to claude, env markers select codex", () => {
  assert.equal(detectHost({}), "claude");
  assert.equal(detectHost({ CODEX_HOME: "/x" }), "codex");
  assert.equal(detectHost({ CODEX_CLI: "1" }), "codex");
  assert.equal(detectHost({ CLAUDE_PLUGIN_ROOT: "/p" }), "claude");
});

test("detectHost: codex plugin-root path betrays compat CLAUDE_PLUGIN_ROOT", () => {
  assert.equal(
    detectHost({ CLAUDE_PLUGIN_ROOT: "C:\\Users\\u\\.codex\\plugins\\cache\\mkt\\plug\\1.0" }),
    "codex",
  );
  assert.equal(
    detectHost({ CLAUDE_PLUGIN_ROOT: "C:\\Users\\u\\.claude\\plugins\\cache\\mkt\\plug\\1.0" }),
    "claude",
  );
});

test("detectHost: codex-only envelope fields (turn_id, rollout transcript)", () => {
  // Verified shape from codex-cli 0.162.1 hook dumps.
  assert.equal(detectHost({}, { turn_id: "01a", hook_event_name: "Stop" }), "codex");
  assert.equal(
    detectHost({}, { transcript_path: "C:\\Users\\u\\.codex\\sessions\\2026\\10\\13\\rollout-x.jsonl" }),
    "codex",
  );
  assert.equal(detectHost({}, { transcript_path: "/home/u/.claude/projects/-x/abc.jsonl" }), "claude");
  assert.equal(detectHost({}, { hook_event_name: "SessionStart" }), "claude");
});

test("detectHost: TOKENSAVER_HOST forces, unknown value falls back to claude", () => {
  assert.equal(detectHost({ TOKENSAVER_HOST: "codex" }), "codex");
  assert.equal(detectHost({ TOKENSAVER_HOST: "nonexistent" }), "claude");
  assert.equal(detectHost({ TOKENSAVER_HOST: "codex", CODEX_HOME: "/x" }), "codex");
});

test("every registered adapter exposes the same surface", () => {
  for (const name of HOST_NAMES) {
    const host = getHost({ TOKENSAVER_HOST: name });
    assert.equal(host.name, name);
    for (const key of ["homeDir", "legacyHome", "normalizeHookInput", "toolNames", "capabilities", "hostSettingsFile"]) {
      assert.ok(host[key] !== undefined, `${name} missing ${key}`);
    }
    assert.ok(typeof host.toolNames.mcpPrefix === "string", `${name} missing mcpPrefix`);
    for (const cap of Object.keys(claude.capabilities)) {
      assert.ok(cap in codex.capabilities, `codex missing capability ${cap}`);
    }
  }
});

test("claude adapter: normalization is identity", () => {
  const raw = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } };
  assert.equal(claude.normalizeHookInput(raw), raw);
});

test("codex adapter: tolerates camelCase event name", () => {
  const out = codex.normalizeHookInput({ hookEventName: "SessionStart", session_id: "s1" });
  assert.equal(out.hook_event_name, "SessionStart");
});

test("homeDir: per-host, distinct paths", () => {
  assert.match(claude.homeDir(), /\.claude[\\/]tokensaver$/);
  assert.match(codex.homeDir(), /\.codex[\\/]tokensaver$/);
  assert.equal(claude.legacyHome() != null, true);
  assert.equal(codex.legacyHome(), null);
});

test("getHost memoizes by name and re-resolves on env change", () => {
  _resetHost();
  const a = getHost({ TOKENSAVER_HOST: "claude" });
  const b = getHost({ TOKENSAVER_HOST: "claude" });
  assert.equal(a, b, "same env → same adapter");
  const c = getHost({ TOKENSAVER_HOST: "codex" });
  assert.equal(c.name, "codex", "env change → re-resolve");
  _resetHost();
});
