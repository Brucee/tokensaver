import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.TOKENSAVER_HOME = mkdtempSync(join(tmpdir(), "ts-digest-"));

const { markPendingCompaction, clearPendingCompaction, buildPostCompactionDigest, rankDroppedTurns } = await import(
  "../src/lib/compaction-digest.mjs"
);

const SID = "sess-digest-1";
let dir, transcript;

function entry(obj) {
  return JSON.stringify(obj) + "\n";
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ts-digest-tx-"));
  transcript = join(dir, "session.jsonl");

  const lines = [];
  // --- pre-compaction window (boundary #0 is the previous compaction) ---
  lines.push(entry({ type: "system", subtype: "compact_boundary", uuid: "b0", timestamp: "2026-10-12T10:00:00Z" }));
  lines.push(entry({ type: "user", uuid: "u1", message: { role: "user", content: "fix the checkout timeout bug" } }));
  lines.push(entry({
    type: "assistant", uuid: "a1",
    message: { role: "assistant", content: [
      { type: "text", text: "Looking at the payment flow" },
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/checkout.js" } },
    ] },
  }));
  lines.push(entry({
    type: "assistant", uuid: "a2",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test -- checkout" } },
    ] },
  }));
  // Turn that is already covered by the summary direction — should be skipped
  lines.push(entry({ type: "user", uuid: "u2", message: { role: "user", content: "checkout timeout retry pending tasks" } }));
  // --- latest compaction: preserves u1+a1, drops a2/u2 ---
  lines.push(entry({
    type: "system", subtype: "compact_boundary", uuid: "b1", timestamp: "2026-10-12T11:00:00Z",
    compactMetadata: { preservedMessages: { allUuids: ["u1", "a1"] } },
  }));
  lines.push(entry({ type: "user", uuid: "sum1", isCompactSummary: true, message: { role: "user", content: "Summary.\n\n## Pending Tasks\nfinish the checkout timeout retry and rerun npm test" } }));
  // post-compaction turn (outside the dropped window)
  lines.push(entry({ type: "assistant", uuid: "a3", message: { role: "assistant", content: [{ type: "text", text: "Continuing" }] } }));
  writeFileSync(transcript, lines.join(""), "utf8");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(process.env.TOKENSAVER_HOME, { recursive: true, force: true });
});

test("digest lists dropped turns ranked, with recall ids", async () => {
  markPendingCompaction(SID);
  const out = await buildPostCompactionDigest(SID, transcript);
  assert.ok(out, "digest produced");
  assert.match(out, /Recovered from before the last compaction/);
  assert.match(out, /recall --id sess-digest-1:<id>/);
  // a2's tool pointer is the most useful dropped item
  assert.match(out, /Bash: npm test -- checkout \[id: u1\]/);
  // marker consumed
  const again = await buildPostCompactionDigest(SID, transcript);
  assert.equal(again, undefined);
});

test("category boost: error turn outranks identical plain turn", () => {
  // Same token set → same base BM25 score; the error flag must break the tie.
  const analysis = {
    droppedTurns: [
      { uuid: "plain", turnAnchorUuid: "u", fields: { text: "bash command alpha", toolCall: "", error: false }, toolPointer: undefined },
      { uuid: "erred", turnAnchorUuid: "u", fields: { text: "bash command alpha", toolCall: "", error: true }, toolPointer: undefined },
    ],
    retainedTokens: new Set(),
    directionQuery: "alpha",
  };
  const ranked = rankDroppedTurns(analysis);
  assert.equal(ranked[0].uuid, "erred");
});

test("error flag propagates from tool_result to the calling turn", async () => {
  const t2 = join(dir, "errprop.jsonl");
  const lines = [
    entry({ type: "system", subtype: "compact_boundary", uuid: "b0", timestamp: "2026-10-12T10:00:00Z" }),
    entry({ type: "user", uuid: "u1", message: { role: "user", content: "run the alpha deploy" } }),
    entry({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "alpha work deploy" } },
    ] } }),
    entry({ type: "user", uuid: "u2", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", is_error: true, content: "exit 1" },
    ] } }),
    // a competing plain turn sharing the same query token (separate turn →
    // separate anchor; bullets dedup by turn so both survive only this way)
    entry({ type: "user", uuid: "u3", message: { role: "user", content: "and then?" } }),
    entry({ type: "assistant", uuid: "a2", message: { role: "assistant", content: [
      { type: "text", text: "alpha noted" },
    ] } }),
    entry({ type: "system", subtype: "compact_boundary", uuid: "b1", timestamp: "2026-10-12T11:00:00Z",
      compactMetadata: { preservedMessages: { allUuids: ["u1"] } } }),
    entry({ type: "user", uuid: "s1", isCompactSummary: true, message: { role: "user", content: "Sum.\n\n## Pending Tasks\nalpha work" } }),
  ];
  writeFileSync(t2, lines.join(""), "utf8");
  markPendingCompaction("errprop");
  const out = await buildPostCompactionDigest("errprop", t2);
  // the failed Bash call is boosted above the competing plain-text turn
  const iErr = out.indexOf("Bash: alpha work deploy");
  const iPlain = out.indexOf("alpha noted");
  assert.ok(iErr !== -1, "error bullet present");
  assert.ok(iPlain !== -1, "plain bullet present");
  assert.ok(iErr < iPlain, "error turn ranks first");
});

test("no marker → nothing", async () => {
  clearPendingCompaction("nope");
  assert.equal(await buildPostCompactionDigest("nope", transcript), undefined);
});

test("expired marker → nothing", async () => {
  markPendingCompaction("stale");
  // age it beyond TTL by rewriting the file
  const { writeFileSync: wf } = await import("node:fs");
  const p = join(process.env.TOKENSAVER_HOME, "post-compaction-digest", "stale.json");
  wf(p, JSON.stringify({ pendingSinceMs: Date.now() - 901_000 }));
  assert.equal(await buildPostCompactionDigest("stale", transcript), undefined);
});

test("no boundary in transcript → keeps marker for retry, returns nothing", async () => {
  const empty = join(dir, "noboundary.jsonl");
  writeFileSync(empty, entry({ type: "user", uuid: "x", message: { role: "user", content: "hi" } }));
  markPendingCompaction("nob");
  assert.equal(await buildPostCompactionDigest("nob", empty), undefined);
  // marker preserved — boundary may not be flushed to disk yet
  const m = JSON.parse((await import("node:fs")).readFileSync(join(process.env.TOKENSAVER_HOME, "post-compaction-digest", "nob.json"), "utf8"));
  assert.equal(typeof m.pendingSinceMs, "number");
});
