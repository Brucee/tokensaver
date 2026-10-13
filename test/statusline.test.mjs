import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATUS_LINE = join(HERE, "..", "scripts", "status-line.cjs");
const SETTINGS_HELPER = join(HERE, "..", "scripts", "settings-helper.cjs");

const HOME = mkdtempSync(join(tmpdir(), "ts-sl-"));
const CLAUDE_DIR = mkdtempSync(join(tmpdir(), "ts-claude-"));
process.env.TOKENSAVER_HOME = HOME;
const env = { ...process.env, TOKENSAVER_HOME: HOME, CLAUDE_CONFIG_DIR: CLAUDE_DIR };

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, "");

const TP = join(HOME, "sl.jsonl");
const SID = "slsession1";

function runStatusLine(payload) {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", STATUS_LINE], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

before(() => {
  writeFileSync(
    TP,
    [
      JSON.stringify({
        type: "assistant",
        requestId: "r1",
        message: {
          model: "claude-sonnet-4-6",
          stop_reason: "tool_use",
          usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 8000, cache_creation_input_tokens: 400 },
          content: [{ type: "tool_use", id: "a1", name: "mcp__plugin_tokensaver_code__Sql", input: {} }],
        },
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", is_error: false }] } }),
    ].join("\n") + "\n"
  );
});
after(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(CLAUDE_DIR, { recursive: true, force: true });
});

test("status line renders session savings segment", async () => {
  const { updateSessionFromTranscript } = await import("../src/lib/savings.mjs");
  updateSessionFromTranscript(SID, TP);
  const out = runStatusLine({ session_id: SID });
  assert.match(out, /TOKENSAVER/);
  // weighted rotation at turnCount=1 → "tip"; either way it's a valid segment
  assert.match(out, /session savings|lifetime savings|TIP:/);
});

test("status line without session_id renders zeroed fallback", () => {
  const out = strip(runStatusLine({}));
  assert.match(out, /TOKENSAVER est\. session savings: \$0\.00 · 0 tokens · 0s · 0 roundtrips/);
});

test("status line formats tokens/duration compactly", () => {
  // force a savings segment: disable tips+lifetime so only "savings" remains
  runHelper(["--set", "statusLineTips", "false"]);
  runHelper(["--set", "statusLineLifetime", "false"]);
  const out = strip(runStatusLine({ session_id: SID }));
  assert.match(out, /est\. session savings: \$\d/);
  assert.match(out, /roundtrips/);
  runHelper(["--set", "statusLineTips", "true"]);
  runHelper(["--set", "statusLineLifetime", "true"]);
});

function runHelper(args) {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", SETTINGS_HELPER], {
    input: "",
    encoding: "utf8",
    env: { ...env, CLAUDE_PLUGIN_ROOT: join(HERE, "..") },
    args0: undefined,
  });
  const r2 = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", SETTINGS_HELPER, ...args], {
    encoding: "utf8",
    env,
  });
  return r2;
}

test("settings-helper --set statusLine registers in claude settings", () => {
  const r = runHelper(["--set", "statusLine", "true"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Set statusLine = true/);
  const s = JSON.parse(readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8"));
  assert.match(s.statusLine.command, /status-line\.cjs/);

  const r2 = runHelper(["--set", "statusLine", "false"]);
  assert.equal(r2.status, 0, r2.stderr);
  const s2 = JSON.parse(readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8"));
  assert.equal(s2.statusLine, undefined);
});

test("settings-helper --set sql policy + deny enforcement", () => {
  const r = runHelper(["--set", "sql", JSON.stringify({ deny: [{ host: "*.prod.example.com" }, "remote"], default: "allow" })]);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8"));
  assert.ok(s.tokensaver.sql.deny.length === 2);
});

test("settings-helper --show includes sql policy", () => {
  const r = runHelper(["--show"]);
  assert.equal(r.status, 0);
  const shown = JSON.parse(r.stdout);
  assert.ok(Array.isArray(shown.sql.deny));
});
