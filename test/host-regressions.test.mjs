import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bindHost, getHost, _resetHost, detectHost } from "../src/host/index.mjs";
import codex from "../src/host/codex.mjs";
import claude from "../src/host/claude.mjs";
import { tokensaverHome } from "../src/lib/config.mjs";
import { loadSqlPolicy } from "../src/lib/sql-policy.mjs";
import { scanCodexTranscriptDelta, loadSessionState, saveSessionState, lifetimeStats, pricingFor } from "../src/lib/savings.mjs";

const cli = fileURLToPath(new URL("../scripts/tokensaver.mjs", import.meta.url));
const rec = (type, payload) => JSON.stringify({ type, payload }) + "\n";
function isolated(fn) {
  const previous = { ...process.env };
  const parent = resolve(tmpdir());
  const dir = mkdtempSync(join(parent, "ts-host-regression-"));
  process.env.TOKENSAVER_HOME = join(dir, "plugin");
  process.env.CODEX_HOME = join(dir, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  try { return fn(dir); }
  finally {
    _resetHost();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    const rel = relative(parent, dir);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("envelope-only Codex selection persists into configuration and policy modules", () => isolated((dir) => {
  for (const key of ["TOKENSAVER_HOST", "CODEX_HOME", "CODEX_CLI", "CODEX_CI", "CLAUDE_PLUGIN_ROOT"]) delete process.env[key];
  bindHost(process.env, { turn_id: "turn-1" });
  assert.equal(getHost().name, "codex");
  assert.equal(tokensaverHome(), join(dir, "plugin"));
  mkdirSync(tokensaverHome(), { recursive: true });
  writeFileSync(codex.hostSettingsFile(), JSON.stringify({ tokensaver: { sql: { default: "deny" } } }));
  assert.equal(loadSqlPolicy().policy.default, "deny");
  assert.equal(getHost().name, "codex");
  bindHost({ TOKENSAVER_HOST: "claude" });
  assert.equal(getHost().name, "claude");
}));

test("host paths honor config roots and Codex plugin-home overrides", () => isolated((dir) => {
  assert.equal(codex.homeDir(), join(dir, "codex", "tokensaver"));
  assert.equal(claude.homeDir(), join(dir, "claude", "tokensaver"));
  assert.equal(codex.hostSettingsFile(), join(dir, "plugin", "host-settings.json"));
  delete process.env.TOKENSAVER_HOME;
  assert.equal(codex.hostSettingsFile(), join(dir, "codex", "tokensaver", "host-settings.json"));
  assert.equal(detectHost({ TOKENSAVER_HOST: "__proto__" }), "claude");
}));

test("doctor skips Claude statusline on Codex and still checks it on Claude", () => isolated(() => {
  const run = (host) => spawnSync(process.execPath, [cli, "doctor"], {
    env: { ...process.env, TOKENSAVER_HOST: host }, encoding: "utf8",
  });
  const cx = run("codex");
  assert.equal(cx.status, 0, cx.stderr);
  assert.ok(!JSON.parse(cx.stdout).checks.some((c) => c.check === "statusline-registered"));
  const cc = run("claude");
  assert.equal(cc.status, 1);
  assert.ok(JSON.parse(cc.stdout).checks.some((c) => c.check === "statusline-registered" && !c.ok));
}));

test("Codex SQL settings CLI writes only the isolated plugin-home policy", () => isolated((dir) => {
  const result = spawnSync(process.execPath, [cli, "settings", "--set", "sql", '{"default":"deny"}'], {
    env: { ...process.env, TOKENSAVER_HOST: "codex" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const policy = JSON.parse(readFileSync(join(dir, "plugin", "host-settings.json"), "utf8"));
  assert.equal(policy.tokensaver.sql.default, "deny");
  assert.equal(existsSync(join(dir, "codex", "tokensaver", "host-settings.json")), false);
  assert.equal(existsSync(join(dir, "claude", "settings.json")), false);
}));

test("recall honors explicit Codex host even with inherited Claude markers", () => isolated((dir) => {
  const session = "11111111-1111-1111-1111-111111111111";
  const sessions = join(dir, "codex", "sessions", "2026", "10", "13");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-test-" + session + ".jsonl"),
    rec("session_meta", { id: session, cwd: dir }) +
    rec("turn_context", { turn_id: "turn-1" }) +
    rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "host probe" }] }) +
    rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "probe answer" }] }));
  const result = spawnSync(process.execPath, [cli, "recall", "--show", "titles", "--sessions", "all"], {
    env: { ...process.env, TOKENSAVER_HOST: "codex", CLAUDECODE: "1" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).count, 1);
}));

test("stale saves recompute persisted and lifetime totals from merged slices", () => isolated(() => {
  const a = loadSessionState("race"), b = loadSessionState("race");
  a.parent.byteOffset = 100;
  a.parent.savings.callsSaved = 2;
  b.subagents.child = { ...b.parent, byteOffset: 100, savings: { ...b.parent.savings, callsSaved: 3 } };
  saveSessionState("race", a);
  saveSessionState("race", b);
  const raw = JSON.parse(readFileSync(join(tokensaverHome(), "sessions", "race.json"), "utf8"));
  assert.equal(raw.accumulatedSavings.callsSaved, 5);
  assert.equal(loadSessionState("race").accumulatedSavings.callsSaved, 5);
  assert.equal(lifetimeStats().callsSaved, 5);
  // Repair aggregate reads for files persisted by the older version.
  raw.accumulatedSavings.callsSaved = 0;
  writeFileSync(join(tokensaverHome(), "sessions", "race.json"), JSON.stringify(raw));
  assert.equal(lifetimeStats().callsSaved, 5);
}));

test("Codex input cost separates ordinary, cached and cache-written tokens", () => isolated((dir) => {
  const file = join(dir, "rollout.jsonl");
  writeFileSync(file, rec("turn_context", { model: "gpt-5" }) + rec("token_usage_record", {
    usage: { input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 50, output_tokens: 100 },
  }));
  const { scan } = scanCodexTranscriptDelta(file, 0);
  assert.equal(scan.usage.inputTokens, 750);
  assert.equal(scan.usage.cacheReadTokens, 200);
  assert.equal(scan.usage.cacheCreationTokens, 50);
  const rate = pricingFor("gpt-5");
  const expected = (750 * rate.inputPerMillion + 200 * rate.cacheReadPerMillion +
    50 * rate.cacheWritePerMillion + 100 * rate.outputPerMillion) / 1e6;
  assert.ok(Math.abs(scan.usage.costInUsd - expected) < 1e-12);
}));

test("prototype-like model names cannot mutate prototypes or use inherited prices", () => isolated((dir) => {
  const file = join(dir, "rollout.jsonl");
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const model of ["__proto__", "constructor", "toString"]) {
    writeFileSync(file, rec("turn_context", { model }) + rec("token_usage_record", {
      usage: { input_tokens: 10, output_tokens: 1 },
    }));
    const { scan } = scanCodexTranscriptDelta(file, 0);
    assert.equal(scan.usageByModel[model].inputTokens, 10);
    assert.ok(Number.isFinite(scan.usage.costInUsd));
    assert.equal(Object.getPrototypeOf(scan.usageByModel), null);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
}));

test("MCP failures inside direct and exec outputs earn no credit across deltas", () => isolated((dir) => {
  const file = join(dir, "rollout.jsonl");
  const outputs = [
    { isError: true, content: [{ type: "text", text: "Edit failed" }] },
    JSON.stringify({ isError: true }),
    [{ type: "input_text", text: JSON.stringify({ isError: true }) }],
    '{"isError":false}{"isError":true}',
  ];
  for (const name of ["mcp__code__Search", "exec"]) {
    for (const output of outputs) {
      writeFileSync(file, rec("response_item", { type: "custom_tool_call", call_id: "c",
        name, arguments: "{}", input: 'await tools.mcp__code__Search({})' }));
      const pending = new Map();
      const first = scanCodexTranscriptDelta(file, 0, undefined, pending);
      writeFileSync(file, readFileSync(file, "utf8") + rec("response_item", {
        type: "custom_tool_call_output", call_id: "c", output,
      }));
      const second = scanCodexTranscriptDelta(file, first.byteOffset, undefined, pending);
      assert.equal(second.scan.saverCalls, 0);
      assert.equal(pending.size, 0);
    }
  }
  writeFileSync(file, rec("response_item", {
    type: "function_call", call_id: "ok", name: "mcp__code__Search", arguments: "{}",
  }) + rec("response_item", { type: "function_call_output", call_id: "ok", output: '{"isError":false}' }));
  assert.equal(scanCodexTranscriptDelta(file, 0).scan.saverCalls, 1);
}));
