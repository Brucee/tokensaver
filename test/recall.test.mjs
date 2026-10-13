import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tsrecall-"));
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, ".claude");

const {
  tokenize,
  buildBm25Index,
  bm25fScore,
  termFilter,
  claudeReadDocuments,
  claudeCompactionBoundariesMs,
  projectSlug,
  runSearch,
  runTitles,
  runDrill,
  parseArgs,
  parseWhen,
  UsageError,
  outputBudget,
  truncateToUnits,
} = await import(new URL("../src/cli/recall.mjs", import.meta.url).href);

function projectDirFor(dir) {
  const slug = projectSlug(dir);
  const p = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", slug);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeSession(dir, sessionId, events) {
  const file = path.join(dir, sessionId + ".jsonl");
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

const repoA = path.join(tmpHome, "repo-a");
const repoB = path.join(tmpHome, "repo-b");
fs.mkdirSync(repoA, { recursive: true });
fs.mkdirSync(repoB, { recursive: true });
const dirA = projectDirFor(repoA);
const dirB = projectDirFor(repoB);

const ts = (m) => new Date(Date.UTC(2026, 0, 10, 12, m, 0)).toISOString();

writeSession(dirA, "sess-a1", [
  { type: "user", uuid: "u1", timestamp: ts(0), cwd: repoA, message: { role: "user", content: "how do I deploy the frobnicate service" } },
  { type: "assistant", uuid: "a1", timestamp: ts(1), message: { role: "assistant", content: [
    { type: "text", text: "You deploy frobnicate with make deploy." },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "make deploy" } },
  ] } },
  { type: "user", uuid: "u2", timestamp: ts(2), message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "t1", content: "deployed frobnicate v3 OK" },
  ] } },
  { type: "system", subtype: "compact_boundary", timestamp: ts(3), compactMetadata: { trigger: "auto" } },
  { type: "user", uuid: "u3", timestamp: ts(4), message: { role: "user", content: "now fix the zorbax parser" } },
  { type: "assistant", uuid: "a2", timestamp: ts(5), message: { role: "assistant", content: [
    { type: "text", text: "Fixed the zorbax parser in parser/zorbax.ts." },
    { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "parser/zorbax.ts" } },
  ] } },
]);

writeSession(dirB, "sess-b1", [
  { type: "user", uuid: "u1", timestamp: ts(10), cwd: repoB, message: { role: "user", content: "rotate the quuxlym certificates" } },
  { type: "assistant", uuid: "a1", timestamp: ts(11), message: { role: "assistant", content: [
    { type: "text", text: "Rotated quuxlym certs with certbot." },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "certbot renew quuxlym" } },
    { type: "thinking", thinking: "cert rotation needs sudo" },
  ] } },
  { type: "user", uuid: "u2", timestamp: ts(12), message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "t1", content: "renewed 2 certs" },
  ] } },
]);

// stale session: mtime controlled for sessions-limit tests
const oldFile = writeSession(dirB, "sess-b0", [
  { type: "user", uuid: "u1", timestamp: ts(1), cwd: repoB, message: { role: "user", content: "stale frobnicate chat" } },
]);
fs.utimesSync(oldFile, new Date(2020, 0, 1), new Date(2020, 0, 1));

test("tokenizer: lowercase, compound splitting", () => {
  const toks = tokenize("Deploy parser/Zorbax.TS now");
  assert.ok(toks.includes("deploy"));
  assert.ok(toks.includes("parser/zorbax.ts"));
  assert.ok(toks.includes("parser"));
  assert.ok(toks.includes("zorbax"));
  assert.ok(toks.includes("ts"));
});

test("termFilter prefers all-terms docs, falls back to any", () => {
  const docs = [
    { fields: { text: "alpha beta", toolCall: "", toolResult: "", thinking: "" } },
    { fields: { text: "alpha", toolCall: "", toolResult: "", thinking: "" } },
    { fields: { text: "", toolCall: "", toolResult: "", thinking: "" } },
  ];
  const got = termFilter(docs, (d) => d.fields, ["text"], ["alpha", "beta"]);
  assert.equal(got.length, 1);
  assert.equal(got[0].fields.text, "alpha beta");
  const any = termFilter(docs, (d) => d.fields, ["text"], ["alpha", "gamma"]);
  assert.equal(any.length, 2);
});

test("BM25F ranks matching doc first, empty query scores 0", async () => {
  const docs = [
    { key: "k1", fields: { text: "hello world", toolCall: "" } },
    { key: "k2", fields: { text: "totally different", toolCall: "Bash ls" } },
  ];
  const idx = buildBm25Index(docs, { k1: 1.2, fields: { text: { boost: 1, b: 0.75 }, toolCall: { boost: 1, b: 0.75 } } });
  const scored = bm25fScore(idx, "hello");
  const top = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  assert.equal(top[0].key, "k1");
  assert.ok(scored.every((s) => s.score === 0) === false);
  const none = bm25fScore(idx, "zzz");
  assert.ok(none.every((s) => s.score === 0));
});

test("claude readDocuments: turn assembly, fields, failed-tool shadowing", async () => {
  const dir = projectDirFor(path.join(tmpHome, "shadow-repo"));
  const f = writeSession(dir, "sess-x", [
    { type: "user", uuid: "u1", timestamp: ts(0), message: { role: "user", content: "run the thing" } },
    { type: "assistant", uuid: "a1", timestamp: ts(1), message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "fail" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "ok" } },
    ] } },
    { type: "user", uuid: "u2", timestamp: ts(2), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" },
      { type: "tool_result", tool_use_id: "t2", content: "fine" },
    ] } },
  ]);
  const docs = [];
  for await (const d of claudeReadDocuments(f, { sessionId: "sess-x", projectPath: "p" })) docs.push(d);
  assert.equal(docs.length, 1);
  const fields = docs[0].fields;
  assert.match(fields.toolCall, /Bash \{"command":"ok"\}/);
  assert.ok(!fields.toolCall.includes('"command":"fail"'), "failed tool_use is shadowed");
  assert.ok(!fields.toolResult.includes("boom"), "error tool_result is dropped");
  assert.match(fields.toolResult, /fine/);
  assert.equal(docs[0].turnId, "u1");
});

test("claude compaction boundaries", async () => {
  const file = path.join(dirA, "sess-a1.jsonl");
  const ms = await claudeCompactionBoundariesMs(file);
  assert.equal(ms.length, 1);
  assert.equal(ms[0], Date.parse(ts(3)));
});

test("projectSlug: non-alnum to dash", () => {
  assert.equal(projectSlug("C:\\laragon\\www\\rea"), "C--laragon-www-rea");
});

test("runSearch: this session finds frobnicate", async () => {
  const results = await runSearch({ query: "frobnicate deploy", sessions: "this", sessionId: "sess-a1" }, "claude");
  assert.ok(results.length >= 1);
  assert.equal(results[0].sessionId, "sess-a1");
  assert.match(results[0].toolCall, /make deploy/);
  assert.match(results[0].recallId, /^sess-a1:/);
});

test("runSearch: project scope resolves via cwd head", async () => {
  const results = await runSearch(
    { query: "quuxlym", sessions: "project", projectDir: repoB },
    "claude"
  );
  assert.ok(results.some((r) => r.sessionId === "sess-b1"));
  assert.ok(!results.some((r) => r.sessionId === "sess-a1"));
});

test("runSearch: --in tool only matches tool fields", async () => {
  const toolOnly = await runSearch(
    { query: "certbot", sessions: "project", projectDir: repoB, matchFields: ["tool"] },
    "claude"
  );
  assert.ok(toolOnly.some((r) => r.sessionId === "sess-b1"));
  const textMiss = await runSearch(
    { query: "Rotated", sessions: "project", projectDir: repoB, matchFields: ["tool"] },
    "claude"
  );
  assert.equal(textMiss.length, 0);
});

test("runSearch: --in result matches tool output", async () => {
  const results = await runSearch(
    { query: "deployed", sessions: "this", sessionId: "sess-a1", matchFields: ["result"] },
    "claude"
  );
  assert.equal(results.length, 1);
});

test("runSearch: sessions-limit excludes stale sessions", async () => {
  const results = await runSearch(
    { query: "frobnicate", sessions: "project", projectDir: repoB, sessionsLimit: 1 },
    "claude"
  );
  assert.ok(!results.some((r) => r.sessionId === "sess-b0"));
});

test("runSearch: since filters turns", async () => {
  const sinceMs = Date.parse(ts(3)) + 1;
  const results = await runSearch(
    { query: "deploy", sessions: "this", sessionId: "sess-a1", sinceMs },
    "claude"
  );
  assert.equal(results.length, 0);
});

test("runSearch: since-last-compactions keeps post-boundary turns", async () => {
  const results = await runSearch(
    { query: "zorbax", sessions: "this", sessionId: "sess-a1", sinceLastCompactions: 1 },
    "claude"
  );
  assert.equal(results.length, 1);
  const old = await runSearch(
    { query: "frobnicate", sessions: "this", sessionId: "sess-a1", sinceLastCompactions: 1 },
    "claude"
  );
  assert.equal(old.length, 0);
});

test("runTitles: rows are id/name/timestamp, newest first", async () => {
  const { rows, totalMatched } = await runTitles(
    { query: "", sessions: "project", projectDir: repoA },
    "claude"
  );
  assert.ok(totalMatched >= 2);
  assert.match(rows[0].id, /^sess-a1:/);
  assert.ok(typeof rows[0].name === "string" && rows[0].name.length > 0);
  assert.ok(rows[0].name.length <= 100);
});

test("runDrill: --id fetches the exact turn", async () => {
  const search = await runSearch({ query: "zorbax", sessions: "this", sessionId: "sess-a1" }, "claude");
  const turn = await runDrill(search[0].recallId, {}, "claude");
  assert.match(turn.text, /zorbax/);
  const bad = await runDrill("nocolon", {}, "claude");
  assert.match(bad.error, /Malformed --id/);
});

test("self-pollution: recall skill invocations are filtered", async () => {
  const dir = projectDirFor(path.join(tmpHome, "poll-repo"));
  writeSession(dir, "sess-p", [
    { type: "user", uuid: "u1", timestamp: ts(0), cwd: tmpHome, message: { role: "user", content: "<command-name>/tokensaver:recall frobnicate" } },
    { type: "assistant", uuid: "a1", timestamp: ts(1), message: { role: "assistant", content: [{ type: "text", text: "frobnicate answer here" }] } },
    { type: "user", uuid: "u2", timestamp: ts(2), message: { role: "user", content: "where is frobnicate deployed" } },
    { type: "assistant", uuid: "a2", timestamp: ts(3), message: { role: "assistant", content: [{ type: "text", text: "in eu-west" }] } },
  ]);
  const results = await runSearch({ query: "frobnicate", sessions: "this", sessionId: "sess-p" }, "claude");
  assert.equal(results.length, 1);
  assert.match(results[0].text, /where is frobnicate deployed/);
});

test("parseArgs: flags and errors", () => {
  const p = parseArgs(["deploy", "--sessions", "project", "--in", "tool,result", "--limit", "3", "--since", "2 days ago"]);
  assert.equal(p.options.query, "deploy");
  assert.equal(p.options.sessions, "project");
  assert.deepEqual(p.options.matchFields.sort(), ["result", "tool"]);
  assert.equal(p.options.limit, 3);
  assert.ok(p.options.sinceMs > 0);
  const sep = parseArgs(["--in", "tool", "--", "-weird-query"]);
  assert.equal(sep.options.query, "-weird-query");
  assert.throws(() => parseArgs(["q", "--sessions", "bogus"]), UsageError);
  assert.throws(() => parseArgs(["q", "--limit", "0"]), UsageError);
  assert.throws(() => parseArgs(["q", "--since", "never-ever"]), UsageError);
  assert.throws(() => parseArgs(["q", "--in", "bogus"]), UsageError);
});

test("parseWhen: relative and named times", () => {
  assert.equal(parseWhen("today"), new Date().setHours(0, 0, 0, 0));
  assert.ok(Math.abs(parseWhen("5 min ago") - (Date.now() - 300000)) < 2000);
  assert.ok(Math.abs(parseWhen("2 hours ago") - (Date.now() - 7200000)) < 2000);
  assert.ok(Math.abs(parseWhen("3 days ago") - (Date.now() - 259200000)) < 2000);
  assert.equal(parseWhen("bogus string"), undefined);
});

test("outputBudget: BASH_MAX_OUTPUT_LENGTH honored and capped", () => {
  delete process.env.BASH_MAX_OUTPUT_LENGTH;
  assert.equal(outputBudget("claude"), 30000);
  process.env.BASH_MAX_OUTPUT_LENGTH = "50000";
  assert.equal(outputBudget("claude"), 50000);
  process.env.BASH_MAX_OUTPUT_LENGTH = "999999";
  assert.equal(outputBudget("claude"), 150000);
  process.env.BASH_MAX_OUTPUT_LENGTH = "abc";
  assert.equal(outputBudget("claude"), 30000);
  delete process.env.BASH_MAX_OUTPUT_LENGTH;
});

test("truncateToUnits: newline-aware, marker fits", () => {
  const text = "line1\nline2\nline3\n" + "x".repeat(500);
  const { text: kept } = truncateToUnits(text, 20);
  assert.equal(kept, "line1\nline2\nline3");
});
