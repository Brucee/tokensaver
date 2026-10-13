import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "ts-save-"));
process.env.TOKENSAVER_HOME = HOME;

const { updateSessionFromTranscript, loadSessionState, equivalentCallsFor, savingsFor, pricingFor, lifetimeStats } =
  await import("../src/lib/savings.mjs");

const SID = "testsession1";
const TP = join(HOME, "t.jsonl");

function assistant(requestId, model, usage, toolUses = []) {
  return JSON.stringify({
    type: "assistant",
    requestId,
    message: {
      model,
      stop_reason: "tool_use",
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 500, ...usage },
      content: toolUses.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input ?? {} })),
    },
  });
}

function toolResult(id, isError = false) {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] } });
}

const SEARCH = "mcp__plugin_tokensaver_code__Search";
const EDIT = "mcp__plugin_tokensaver_code__Edit";
const SQL = "mcp__plugin_tokensaver_code__Sql";

before(() => {
  writeFileSync(TP, "");
});
after(() => rmSync(HOME, { recursive: true, force: true }));

test("equivalentCallsFor weights", () => {
  assert.equal(equivalentCallsFor(SEARCH, {}), 2);
  assert.equal(equivalentCallsFor(SEARCH, { file_glob_patterns: ["a", "b", "c"], content_regex: "x", summary: true }), 2 + 2 + 1 + 1);
  assert.equal(equivalentCallsFor(SQL, {}), 5);
  assert.equal(equivalentCallsFor(EDIT, { edits: [{ file_path: "a" }, { file_path: "b" }, { file_path: "a" }] }), 3 + 2 + 0.5);
  assert.equal(equivalentCallsFor("Read", {}), 0);
});

test("pricingFor boundary match", () => {
  assert.equal(pricingFor("claude-sonnet-4-6").inputPerMillion, 3);
  assert.equal(pricingFor("us.anthropic.claude-opus-4-5-20251001-v1:0").inputPerMillion, 5);
  assert.equal(pricingFor("claude-sonnet-x").inputPerMillion, 3); // falls back, no false match
  assert.equal(pricingFor(undefined).inputPerMillion, 3);
  assert.equal(pricingFor("gpt-5.4-mini").outputPerMillion, 4.5);
});

test("savingsFor formula", () => {
  const s = savingsFor(5, 1000, 10000, 500, 200, "claude-sonnet-4-6");
  assert.equal(s.callsSaved, 4);
  assert.equal(s.timeSavedInMs, 100000);
  assert.equal(s.tokensSaved, Math.round(4 * 1000 * 1.3) + Math.round(4 * 10000 * 1.3) + Math.round(4 * 500 * 1.3) + Math.round(4 * 200));
});

test("incremental transcript scan counts only successful own-tool calls", () => {
  const lines = [
    assistant("req1", "claude-sonnet-4-6", {}, [{ id: "t1", name: SEARCH, input: { content_regex: "foo" } }, { id: "t2", name: "Read", input: {} }]),
    toolResult("t1"),
    assistant("req2", "claude-sonnet-4-6", {}, [{ id: "t3", name: SQL, input: { sql: "select 1" } }]),
    toolResult("t3"),
  ].join("\n") + "\n";
  writeFileSync(TP, lines);
  const state = updateSessionFromTranscript(SID, TP);
  assert.equal(state.totalSaverCalls, 2);           // t1 + t3 (t2 not ours)
  assert.equal(state.equivalentNativeToolCalls, 3 + 5); // Search(2+1 regex) + Sql(5)
  assert.equal(state.usage.turnCount, 2);
  // equiv 8, calls 2 → saved (8-2)+1 = 7 → callsSaved 6
  assert.equal(state.accumulatedSavings.callsSaved, 6);
  assert.ok(state.accumulatedSavings.costSavedInUsd > 0);
});

test("errored tool_result does not count", () => {
  const lines = [
    assistant("req3", "claude-sonnet-4-6", {}, [{ id: "t9", name: SQL, input: {} }]),
    toolResult("t9", true),
  ].join("\n") + "\n";
  appendFileSync(TP, lines);
  const state = updateSessionFromTranscript(SID, TP);
  assert.equal(state.totalSaverCalls, 2); // unchanged — t9 was an error
});

test("incremental re-scan with no new bytes is a no-op", () => {
  const before1 = loadSessionState(SID);
  const state = updateSessionFromTranscript(SID, TP);
  assert.equal(state.totalSaverCalls, before1.totalSaverCalls);
  assert.equal(state.usage.turnCount, before1.usage.turnCount);
});

test("requestId dedup on resumed scan", () => {
  // Re-append an already-seen requestId — must not double-count usage.
  appendFileSync(TP, assistant("req2", "claude-sonnet-4-6", {}) + "\n");
  const state = updateSessionFromTranscript(SID, TP);
  assert.equal(state.usage.turnCount, 3); // req1, req2, req3 — not 4
});

test("lifetimeStats aggregates sessions", () => {
  const lt = lifetimeStats();
  assert.ok(lt.callsSaved >= 6);
  assert.equal(lt.sessionCount, 1);
});
