// Regressions for the 1.0.8 review fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compactNumber, plainCount, money } from "../src/lib/format.mjs";
import { stripJsonc } from "../src/router/config.mjs";
import { runSearch } from "../src/tools/search.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ANSI = /\x1b\[[0-9;]*m/g;

test("compactNumber rolls over to the next unit instead of 1000K", () => {
  assert.equal(compactNumber(999_499), "999K");
  assert.equal(compactNumber(999_500), "1.0M");
  assert.equal(compactNumber(999_999), "1.0M");
  assert.equal(compactNumber(999_960_000), "1.0B");
});

test("plainCount/money use a fixed en-US grouping", () => {
  assert.equal(plainCount(1_234_567), "1,234,567");
  assert.equal(money(12_345.4), "$12,345");
});

test("stripJsonc drops a trailing comma followed by a comment", () => {
  assert.deepEqual(JSON.parse(stripJsonc('{"a": [1, // note\n], "b": 2, /* x */ }')), { a: [1], b: 2 });
});

function statusLineEnv() {
  const home = mkdtempSync(join(tmpdir(), "ts-108-"));
  mkdirSync(join(home, "sessions"), { recursive: true });
  return { home, env: { ...process.env, TOKENSAVER_HOME: home, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "ts-108c-")) } };
}

function renderStatus(env, home, sid, state) {
  writeFileSync(join(home, "sessions", `${sid}.json`), JSON.stringify(state));
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "status-line.cjs")], { input: JSON.stringify({ session_id: sid }), encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.replace(ANSI, "");
}

test("status line rotates through every tip with default segments", () => {
  const { home, env } = statusLineEnv();
  const tips = new Set();
  // Default segments rotate savings → lifetime → tip every 20s; slot 3k+2 is the tip.
  for (let k = 0; k < 5; k++) {
    // Session totals are rolled up from the slices on load.
    const out = renderStatus({ ...env, TOKENSAVER_STATUS_NOW_MS: String((3 * k + 2) * 20_000) }, home, "tips", {
      parent: { usage: { turnCount: 1 }, saverCalls: 1, savings: { callsSaved: 1, timeSavedInMs: 25000, tokensSaved: 10, costSavedInUsd: 0.01 } },
    });
    const m = /TIP: (.*?)\s*$/.exec(out);
    assert.ok(m, out);
    tips.add(m[1]);
  }
  assert.equal(tips.size, 5);
  rmSync(home, { recursive: true, force: true });
});

test("status line rotates segments on a 20s clock", () => {
  const { home, env } = statusLineEnv();
  const state = { parent: { usage: { turnCount: 1 }, saverCalls: 1, savings: { callsSaved: 1, timeSavedInMs: 25000, tokensSaved: 10, costSavedInUsd: 0.01 } } };
  const at = (ms) => renderStatus({ ...env, TOKENSAVER_STATUS_NOW_MS: String(ms) }, home, "clock", state);
  assert.match(at(20_000 * 3), /session savings/);
  assert.match(at(20_000 * 3 + 19_999), /session savings/);
  assert.match(at(20_000 * 4), /lifetime savings/);
  assert.match(at(20_000 * 5), /TIP:/);
  rmSync(home, { recursive: true, force: true });
});

test("status line registration sets a 20s refreshInterval and upgrades old entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-108r-"));
  const saved = { c: process.env.CLAUDE_CONFIG_DIR, h: process.env.TOKENSAVER_HOME };
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.TOKENSAVER_HOME = mkdtempSync(join(tmpdir(), "ts-108h-"));
  try {
    const { registerStatusLine, statusLineCommand } = await import("../src/lib/claude-settings.mjs");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: statusLineCommand(ROOT), padding: 0 } }));
    registerStatusLine(ROOT);
    const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.equal(s.statusLine.refreshInterval, 20);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = saved.c;
    process.env.TOKENSAVER_HOME = saved.h;
    if (saved.c === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    if (saved.h === undefined) delete process.env.TOKENSAVER_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status line warns once the context passes 200K", () => {
  const { home, env } = statusLineEnv();
  const big = renderStatus(env, home, "ctxbig", { parent: { usage: { turnCount: 3 }, lastContextTokens: 240_000 } });
  assert.match(big, /context 240K re-read every turn — compact at the next milestone/);
  const small = renderStatus(env, home, "ctxsmall", { parent: { usage: { turnCount: 3 }, lastContextTokens: 150_000 } });
  assert.doesNotMatch(small, /context/);
  rmSync(home, { recursive: true, force: true });
});

test("status line shows a tip instead of zeros before any savings", () => {
  const { home, env } = statusLineEnv();
  const out = renderStatus(env, home, "fresh", { parent: { usage: { turnCount: 3 } } });
  assert.match(out, /TIP:/);
  rmSync(home, { recursive: true, force: true });
});

test("doctor leaves no probe file and checks the review agent", () => {
  const { home, env } = statusLineEnv();
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "tokensaver.mjs"), "doctor"], { encoding: "utf8", env });
  const report = JSON.parse(r.stdout);
  assert.ok(report.checks.find((c) => c.check === "agents").ok);
  assert.ok(!existsSync(join(home, ".doctor-probe")));
  rmSync(home, { recursive: true, force: true });
});

function runHook(payload) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "session-hook.cjs")], { input: JSON.stringify(payload), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  return out === "" ? undefined : JSON.parse(out);
}

test("edit batching nudge is tracked per session", () => {
  const edit = (sid) => runHook({
    session_id: sid, transcript_path: "t.jsonl", cwd: ROOT, hook_event_name: "PreToolUse",
    tool_name: "mcp__plugin_tokensaver_code__Edit", tool_input: { cwd: ROOT, edits: [{ file_path: "a.txt", new_string: "x" }] },
  });
  const a = `nudgeA${Date.now()}`, b = `nudgeB${Date.now()}`;
  assert.equal(edit(a), undefined);
  assert.equal(edit(b), undefined, "another session's edit must not trigger the nudge");
  assert.match(edit(a).hookSpecificOutput.additionalContext, /batching/);
});

test("Search truncation reports a single notice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-108s-"));
  for (let i = 0; i < 30; i++) writeFileSync(join(dir, `f${i}.txt`), ("line of text " + i + "\n").repeat(60));
  const prev = process.env.TOKENSAVER_MAX_MCP_OUTPUT_TOKENS;
  process.env.TOKENSAVER_MAX_MCP_OUTPUT_TOKENS = "4000";
  try {
    const big = (await runSearch({ cwd: dir, file_glob_patterns: ["*.txt"] })).content[0].text;
    assert.doesNotMatch(big, /Search stopped at the output budget/);
    assert.match(big, /Output exceeded total-content cap of 5,760 chars: .*remaining files not read/);
    assert.match(big, /Reuse if_modified_since/);
    const small = (await runSearch({ cwd: dir, file_glob_patterns: ["f0.txt#1-2"] })).content[0].text;
    assert.doesNotMatch(small, /Reuse if_modified_since/);
  } finally {
    if (prev === undefined) delete process.env.TOKENSAVER_MAX_MCP_OUTPUT_TOKENS;
    else process.env.TOKENSAVER_MAX_MCP_OUTPUT_TOKENS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
