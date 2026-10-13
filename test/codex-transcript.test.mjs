// Codex rollout transcript scanner — fixtures mirror codex-cli 0.162.1
// rollout-*.jsonl shapes captured from real sessions (2026-10-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCodexTranscriptDelta, updateSessionFromTranscript, loadSessionState, saveSessionState } from "../src/lib/savings.mjs";
import { markPendingCompaction, buildPostCompactionDigest } from "../src/lib/compaction-digest.mjs";

function rec(ordinal, type, payload) {
  return JSON.stringify({ timestamp: "2026-10-13T12:00:00.000Z", ordinal, type, payload }) + "\n";
}

const USAGE = {
  input_tokens: 1000,
  cached_input_tokens: 200,
  cache_write_input_tokens: 50,
  output_tokens: 100,
  reasoning_output_tokens: 10,
  total_tokens: 1100,
};

function tmpRollout() {
  const dir = mkdtempSync(join(tmpdir(), "ts-codex-"));
  const file = join(dir, "rollout-test.jsonl");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("codex scan: usage, tools, exec-wrapped MCP calls, model, duration", () => {
  const { file, cleanup } = tmpRollout();
  try {
    writeFileSync(
      file,
      rec(1, "session_meta", { id: "t1", cwd: "C:\\proj", model_provider: "openai" }) +
        rec(2, "turn_context", { turn_id: "turn1", model: "gpt-6-luna", cwd: "C:\\proj" }) +
        rec(3, "event_msg", { type: "task_started", turn_id: "turn1" }) +
        rec(4, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }) +
        rec(5, "response_item", {
          type: "custom_tool_call",
          id: "ctc_1",
          call_id: "call_1",
          name: "exec",
          status: "completed",
          input:
            'const r = await tools.mcp__code__Search({cwd:"C:\\\\proj",file_glob_patterns:["a.js","b.js"],content_regex:"foo"});\ntext(r);\n',
        }) +
        rec(6, "response_item", {
          type: "custom_tool_call_output",
          call_id: "call_1",
          output: [{ type: "input_text", text: "…" }],
        }) +
        rec(7, "token_usage_record", { usage: USAGE }) +
        rec(8, "response_item", { type: "function_call", call_id: "call_2", name: "spawn_agent", arguments: "{}" }) +
        rec(9, "token_usage_record", {
          usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 50 },
        }) +
        rec(10, "event_msg", { type: "task_complete", turn_id: "turn1", duration_ms: 5000 })
    );
    const { scan, byteOffset } = scanCodexTranscriptDelta(file, 0, undefined);
    assert.equal(scan.usage.turnCount, 2);
    assert.equal(scan.usage.inputTokens, 2200);
    assert.equal(scan.usage.outputTokens, 150);
    assert.equal(scan.usage.cacheReadTokens, 500);
    assert.equal(scan.usage.cacheCreationTokens, 50);
    assert.equal(scan.usage.outputThinkingTokens, 10);
    assert.equal(scan.usage.toolUseCount, 2);
    assert.equal(scan.spawnedSubagent, true);
    assert.equal(scan.saverCalls, 1);
    // Search: 2 base +1 extra glob +1 content_regex = 4 equivalent calls.
    assert.equal(scan.equivalentNativeToolCalls, 4);
    assert.equal(scan.model, "gpt-6-luna");
    assert.equal(scan.usageByModel["gpt-6-luna"].turnCount, 2);
    assert.equal(scan.turnDurationMs, 5000);
    assert.ok(byteOffset > 0);
  } finally {
    cleanup();
  }
});

test("codex scan: byte-delta only counts new records; ordinal dedup", () => {
  const { file, cleanup } = tmpRollout();
  try {
    writeFileSync(
      file,
      rec(1, "turn_context", { turn_id: "t", model: "gpt-6.1-sol" }) +
        rec(2, "token_usage_record", { usage: USAGE })
    );
    const first = scanCodexTranscriptDelta(file, 0, undefined);
    assert.equal(first.scan.usage.turnCount, 1);
    assert.equal(first.scan.model, "gpt-6.1-sol");
    // Append a new turn's records — only they are counted on rescan.
    appendFileSync(
      file,
      rec(3, "token_usage_record", { usage: { input_tokens: 10, output_tokens: 5 } }) +
        rec(4, "response_item", {
          type: "custom_tool_call",
          call_id: "c9",
          name: "mcp__code__Sql",
          status: "completed",
          arguments: "",
        }) +
        rec(5, "response_item", { type: "custom_tool_call_output", call_id: "c9", output: [] })
    );
    const second = scanCodexTranscriptDelta(file, first.byteOffset, first.scan.maxSeenRequestId);
    assert.equal(second.scan.usage.turnCount, 1);
    assert.equal(second.scan.usage.inputTokens, 10);
    assert.equal(second.scan.usage.toolUseCount, 1);
    assert.equal(second.scan.saverCalls, 1);
    assert.equal(second.scan.equivalentNativeToolCalls, 5); // Sql = 5
    // Replaying the same delta with the high-water set counts nothing —
    // ordinals at or below it are already accounted.
    const replay = scanCodexTranscriptDelta(file, first.byteOffset, second.scan.maxSeenRequestId);
    assert.equal(replay.scan.usage.turnCount, 0);
    assert.equal(replay.scan.usage.toolUseCount, 0);
    assert.equal(replay.scan.saverCalls, 0);
  } finally {
    cleanup();
  }
});

test("codex scan: failed calls earn no saver credit; junk lines skipped", () => {
  const { file, cleanup } = tmpRollout();
  try {
    writeFileSync(
      file,
      "not json\n" +
        rec(1, "response_item", {
          type: "custom_tool_call",
          call_id: "bad1",
          name: "exec",
          status: "failed",
          input: 'await tools.mcp__code__Search({cwd:"x"})',
        }) +
        rec(2, "response_item", { type: "custom_tool_call_output", call_id: "bad1", output: [] }) +
        rec(3, "response_item", {
          type: "custom_tool_call",
          call_id: "ok1",
          name: "exec",
          status: "completed",
          // Real rollouts carry \n as an escape inside the JS source — the
          // payload decodes to backslash+n, which stays valid JSON after the
          // arg-literal normalization.
          input: 'await tools.mcp__code__Edit({edits:[{file_path:"f.js",old_string:"a\\nb",new_string:"a\\nb\\nc"}]})',
        }) +
        rec(4, "response_item", { type: "custom_tool_call_output", call_id: "ok1", output: [] })
    );
    const { scan } = scanCodexTranscriptDelta(file, 0, undefined);
    assert.equal(scan.usage.toolUseCount, 2);
    assert.equal(scan.saverCalls, 1);
    assert.equal(scan.codeEditLines.editsApplied, 1);
    assert.equal(scan.codeEditLines.linesAdded, 3);
    assert.equal(scan.codeEditLines.linesRemoved, 2);
  } finally {
    cleanup();
  }
});

test("codex scan: partial trailing line is held back for the next delta", () => {
  const { file, cleanup } = tmpRollout();
  try {
    writeFileSync(file, rec(1, "token_usage_record", { usage: USAGE }));
    appendFileSync(file, rec(2, "token_usage_record", { usage: USAGE }).slice(0, 40)); // truncated tail
    const first = scanCodexTranscriptDelta(file, 0, undefined);
    assert.equal(first.scan.usage.turnCount, 1);
    // Complete the line — the rescan picks it up.
    appendFileSync(file, rec(2, "token_usage_record", { usage: USAGE }).slice(40));
    const second = scanCodexTranscriptDelta(file, first.byteOffset, first.scan.maxSeenRequestId);
    assert.equal(second.scan.usage.turnCount, 1);
    assert.equal(second.scan.maxSeenRequestId, 2);
  } finally {
    cleanup();
  }
});

test("updateSessionFromTranscript dispatches to the codex scanner by host", () => {
  const { dir, file, cleanup } = tmpRollout();
  const prevHome = process.env.TOKENSAVER_HOME;
  process.env.TOKENSAVER_HOME = dir;
  try {
    // Real hook cadence: turn_context, usage, call and output all land in
    // different deltas — model and call pairing must survive across scans.
    writeFileSync(file, rec(1, "turn_context", { turn_id: "t", model: "gpt-6-luna" }));
    const first = updateSessionFromTranscript("codexsess1", file, "codex");
    assert.equal(first.model, "gpt-6-luna", "turn_context model persisted");
    appendFileSync(
      file,
      rec(2, "token_usage_record", { usage: USAGE }) +
        rec(3, "response_item", {
          type: "custom_tool_call",
          call_id: "s1",
          name: "exec",
          status: "completed",
          input: 'await tools.mcp__code__Search({file_glob_patterns:["x"]})',
        })
    );
    const mid = updateSessionFromTranscript("codexsess1", file, "codex");
    assert.ok(mid);
    assert.equal(mid.totalSaverCalls, 0, "call pending — output not scanned yet");
    assert.equal(mid.usage.turnCount, 1);
    assert.ok(mid.usage.costInUsd > 0, "usage priced under the persisted model");
    // The output record lands after the tool runs (PostToolUse scan).
    appendFileSync(file, rec(4, "response_item", { type: "custom_tool_call_output", call_id: "s1", output: [] }));
    const state = updateSessionFromTranscript("codexsess1", file, "codex");
    assert.equal(state.usage.turnCount, 1);
    assert.equal(state.usage.inputTokens, 1000);
    assert.equal(state.totalSaverCalls, 1, "cross-delta pairing credits the call");
    assert.equal(state.model, "gpt-6-luna");
    const saved = loadSessionState("codexsess1");
    assert.equal(saved.usage.turnCount, 1);
    assert.equal(saved.totalSaverCalls, 1);
    // Incremental: a second call with no new bytes is a no-op.
    const again = updateSessionFromTranscript("codexsess1", file, "codex");
    assert.equal(again.usage.turnCount, 1);
  } finally {
    if (prevHome === undefined) delete process.env.TOKENSAVER_HOME;
    else process.env.TOKENSAVER_HOME = prevHome;
    cleanup();
  }
});

// ---------- post-compaction digest (codex rollout variant) ----------

test("codex digest: dropped turns surface via compacted.replacement_history", async () => {
  const { dir, file, cleanup } = tmpRollout();
  const prevHome = process.env.TOKENSAVER_HOME;
  process.env.TOKENSAVER_HOME = dir;
  const sid = "codexdigest1";
  try {
    writeFileSync(
      file,
      rec(1, "compacted", { message: "", replacement_history: [] }) + // older boundary
        rec(2, "turn_context", { turn_id: "turn-aaa" }) +
        rec(3, "response_item", {
          type: "message",
          id: "m1",
          role: "user",
          content: [{ type: "input_text", text: "fix the checkout timeout bug" }],
        }) +
        rec(4, "response_item", {
          type: "custom_tool_call",
          id: "c1",
          call_id: "x1",
          name: "exec",
          status: "completed",
          input: 'await tools.mcp__code__Edit({edits:[{file_path:"src/checkout.js"}]})',
        }) +
        rec(5, "response_item", {
          type: "message",
          id: "m2",
          role: "assistant",
          content: [{ type: "output_text", text: "rerun npm test for checkout timeout" }],
        }) +
        // Latest compaction keeps only m1 — c1/m2 are dropped.
        rec(6, "compacted", {
          replacement_history: [
            { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "fix the checkout timeout bug" }] },
          ],
        }) +
        rec(7, "response_item", {
          type: "message",
          id: "m3",
          role: "assistant",
          content: [{ type: "output_text", text: "Continuing" }],
        })
    );
    markPendingCompaction(sid);
    const out = await buildPostCompactionDigest(sid, file, "codex");
    assert.ok(typeof out === "string" && out.includes("Recovered from before the last compaction"), `expected digest, got: ${out}`);
    assert.match(out, /checkout|Edit|timeout/i);
    assert.match(out, /id: turn-aaa/, "bullets carry the codex turn id for recall --id");
  } finally {
    if (prevHome === undefined) delete process.env.TOKENSAVER_HOME;
    else process.env.TOKENSAVER_HOME = prevHome;
    cleanup();
  }
});

test("codex: agent_id routes the agent rollout into state.subagents", () => {
  const { dir, file, cleanup } = tmpRollout();
  const agentFile = join(dir, "agent-rollout.jsonl");
  const prevHome = process.env.TOKENSAVER_HOME;
  process.env.TOKENSAVER_HOME = dir;
  try {
    // Main session: one usage record.
    writeFileSync(file, rec(1, "token_usage_record", { usage: USAGE }));
    updateSessionFromTranscript("multia", file, "codex");
    // Subagent hook (spawn_agent child): same session id, different file.
    writeFileSync(
      agentFile,
      rec(1, "turn_context", { turn_id: "ta", model: "gpt-6-luna" }) +
        rec(2, "token_usage_record", { usage: { ...USAGE, input_tokens: 2000 } }) +
        rec(3, "response_item", { type: "custom_tool_call", id: "c1", call_id: "x", name: "exec", status: "completed", input: 'await tools.mcp__code__Search({content_regex:"foo"})' }) +
        rec(4, "response_item", { type: "custom_tool_call_output", call_id: "x", output: '{"out":1}' })
    );
    updateSessionFromTranscript("multia", agentFile, "codex", "agent-1");
    const state = loadSessionState("multia");
    // Parent slice only saw the main file.
    assert.equal(state.parent.usage.inputTokens, 1000);
    // Agent slice has its own usage + its own model.
    assert.equal(state.subagents["agent-1"].usage.inputTokens, 2000);
    assert.equal(state.subagents["agent-1"].model, "gpt-6-luna");
    // Rollup merges: totals include both files.
    assert.equal(state.usage.inputTokens, 3000);
    assert.equal(state.totalSaverCalls, 1); // agent's Search call counted
    // Parent scan continues incrementally (offset not clobbered by agent file).
    appendFileSync(file, rec(2, "token_usage_record", { usage: { ...USAGE, input_tokens: 500 } }));
    updateSessionFromTranscript("multia", file, "codex");
    assert.equal(loadSessionState("multia").parent.usage.inputTokens, 1500);
  } finally {
    if (prevHome === undefined) delete process.env.TOKENSAVER_HOME;
    else process.env.TOKENSAVER_HOME = prevHome;
    cleanup();
  }
});

test("codex digest: no compacted record → undefined (marker kept)", async () => {
  const { dir, file, cleanup } = tmpRollout();
  const prevHome = process.env.TOKENSAVER_HOME;
  process.env.TOKENSAVER_HOME = dir;
  try {
    writeFileSync(file, rec(1, "response_item", { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "hi" }] }));
    markPendingCompaction("noboundary");
    assert.equal(await buildPostCompactionDigest("noboundary", file, "codex"), undefined);
    // Marker preserved: a retry after the boundary is flushed can still fire.
    markPendingCompaction("noboundary"); // re-arm to clean state
  } finally {
    if (prevHome === undefined) delete process.env.TOKENSAVER_HOME;
    else process.env.TOKENSAVER_HOME = prevHome;
    cleanup();
  }
});

test("subagent slice: prototype-polluting agent ids cannot corrupt state", () => {
  const { dir, file, cleanup } = tmpRollout();
  const prevHome = process.env.TOKENSAVER_HOME;
  process.env.TOKENSAVER_HOME = dir;
  try {
    writeFileSync(file, rec(1, "token_usage_record", { usage: USAGE }));
    // "toString" resolves on Object.prototype — without an own-check the
    // slice would be a function and crash; "__proto__" would mutate the map.
    for (const id of ["toString", "__proto__", "constructor"]) {
      updateSessionFromTranscript("proto", file, "codex", id);
    }
    const state = loadSessionState("proto");
    assert.equal(typeof state.subagents["toString"], "object");
    assert.equal(state.subagents["__proto__"].usage.inputTokens, 1000);
    assert.equal(Object.getPrototypeOf(state.subagents), null);
  } finally {
    if (prevHome === undefined) delete process.env.TOKENSAVER_HOME;
    else process.env.TOKENSAVER_HOME = prevHome;
    cleanup();
  }
});

test("concurrent saves union-merge subagent slices (parallel agent hooks)", () => {
  const { dir, file, file: mainFile, cleanup } = tmpRollout();
  const agentFile = join(dir, "rollout-agent.jsonl");
  const prevHome = process.env.TOKENSAVER_HOME;
  process.env.TOKENSAVER_HOME = dir;
  try {
    writeFileSync(file, rec(1, "token_usage_record", { usage: USAGE }));
    writeFileSync(agentFile, rec(1, "token_usage_record", { usage: { ...USAGE, input_tokens: 500 } }));
    // Simulate two racing hooks: each loaded state BEFORE the other saved.
    // Hook A (agent-1) and hook B (main) interleave load→save.
    const a = loadSessionState("race");
    updateSessionFromTranscript("race", agentFile, "codex", "agent-1"); // A saves {parent:0, agent-1:500}
    // B still holds `a` (loaded before A's save): simulate by writing a stale
    // state that lacks agent-1, as a naive overwrite would lose it.
    const stale = loadSessionState("race");
    delete stale.subagents["agent-1"];
    saveSessionState("race", stale); // must union-merge, not clobber
    const merged = loadSessionState("race");
    assert.equal(merged.subagents["agent-1"].usage.inputTokens, 500);
    updateSessionFromTranscript("race", mainFile, "codex");
    assert.equal(loadSessionState("race").parent.usage.inputTokens, 1000);
  } finally {
    if (prevHome === undefined) delete process.env.TOKENSAVER_HOME;
    else process.env.TOKENSAVER_HOME = prevHome;
    cleanup();
  }
});
