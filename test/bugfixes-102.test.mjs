// Regression tests for REPORT-REVISIONE.md (v1.0.2 review findings).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runEdit } from "../src/tools/edit.mjs";
import { runSearch } from "../src/tools/search.mjs";
import { checkSyntax } from "../src/lib/syntax.mjs";
import { splitKeepNewline } from "../src/lib/lineio.mjs";
import { scanTranscriptDelta } from "../src/lib/savings.mjs";

const FIX = join(tmpdir(), "tokensaver-bugfix-fixture");
mkdirSync(FIX, { recursive: true });
beforeEach(() => { rmSync(FIX, { recursive: true, force: true }); mkdirSync(FIX, { recursive: true }); });
after(() => rmSync(FIX, { recursive: true, force: true }));

const text = (r) => r.content[0].text;
const write = (f, c) => writeFileSync(join(FIX, f), c);
const read = (f) => readFileSync(join(FIX, f), "utf8");
const edit = (e) => runEdit({ edits: [e] }, { cwd: FIX });

// --- 2. Edit must not clobber an existing file when old_string is absent ---
test("Edit: existing file + no old_string → error, file untouched", async () => {
  write("exists.txt", "keep me\nline2\n");
  const r = await edit({ file_path: "exists.txt", new_string: "clobbered" });
  assert.equal(read("exists.txt"), "keep me\nline2\n");
  assert.match(text(r), /already exists/);
});

test("Edit: missing file + no old_string → create still works", async () => {
  const r = await edit({ file_path: "new.txt", new_string: "created" });
  assert.equal(read("new.txt"), "created");
});

test("Edit: existing file + overwrite:true → full replace allowed", async () => {
  write("exists.txt", "old\n");
  await edit({ file_path: "exists.txt", overwrite: true, new_string: "fresh\n" });
  assert.equal(read("exists.txt"), "fresh\n");
});

// --- 4. Empty old_string → clear error, no loop ---
test("Edit: empty old_string errors instead of looping", async () => {
  write("a.txt", "content\n");
  const r = await edit({ file_path: "a.txt", old_string: "", new_string: "x" });
  assert.match(text(r), /old_string is empty/);
  assert.equal(read("a.txt"), "content\n");
});

// --- 3. CRLF files: LF old_string matches, file keeps \r\n ---
test("Edit: LF old_string matches CRLF file and preserves CRLF", async () => {
  write("win.txt", "one\r\ntwo\r\nthree\r\n");
  const r = await edit({ file_path: "win.txt", old_string: "two", new_string: "TWO" });
  assert.equal(read("win.txt"), "one\r\nTWO\r\nthree\r\n", text(r));
});

test("Edit: multi-line LF needle matches CRLF file", async () => {
  write("win2.txt", "alpha\r\nbeta\r\ngamma\r\n");
  const r = await edit({ file_path: "win2.txt", old_string: "beta\ngamma", new_string: "B\nG" });
  assert.equal(read("win2.txt"), "alpha\r\nB\r\nG\r\n", text(r));
});

test("splitKeepNewline preserves each line's own terminator", () => {
  assert.deepEqual(splitKeepNewline("a\r\nb\nc"), ["a\r\n", "b\n", "c\n"]);
});

// --- 6. .cjs → commonjs (was --input-type=cjs, always an error) ---
test("syntax: .cjs with top-level return is clean", async () => {
  assert.deepEqual(await checkSyntax(join(FIX, "x.cjs"), "return 1;\n"), []);
});

test("syntax: .js under commonjs package allows top-level return", async () => {
  mkdirSync(join(FIX, "cjs"), { recursive: true });
  write("cjs/package.json", '{"name":"x"}'); // no "type" → commonjs
  assert.deepEqual(await checkSyntax(join(FIX, "cjs", "x.js"), "return 1;\n"), []);
});

test("syntax: .js under module package flags top-level return", async () => {
  mkdirSync(join(FIX, "esm"), { recursive: true });
  write("esm/package.json", '{"type":"module"}');
  const problems = await checkSyntax(join(FIX, "esm", "y.js"), "return 1;\n");
  assert.ok(problems.length > 0);
});

// --- 7. ^ and $ anchor at line boundaries ---
test("Search: ^pattern matches mid-file lines", async () => {
  write("s.txt", "alpha\nbeta needle\ngamma\n");
  const r = await runSearch({ file_glob_patterns: ["s.txt"], content_regex: "^beta" }, { cwd: FIX });
  assert.match(text(r), /beta needle/);
});

test("Search: pattern$ matches end-of-line mid-file", async () => {
  write("s.txt", "alpha end\nbeta\ngamma\n");
  const r = await runSearch({ file_glob_patterns: ["s.txt"], content_regex: "end$" }, { cwd: FIX });
  assert.match(text(r), /alpha end/);
});

// --- 8. binary detection: NUL byte, not U+FFFD text ---
test("Search: file containing U+FFFD text is not flagged binary", async () => {
  write("uni.txt", "replacement char: � here\n");
  const r = await runSearch({ file_glob_patterns: ["uni.txt"] }, { cwd: FIX });
  assert.match(text(r), /replacement char/);
});

test("Search: file with NUL byte is flagged binary", async () => {
  writeFileSync(join(FIX, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  const r = await runSearch({ file_glob_patterns: ["bin.dat"] }, { cwd: FIX });
  assert.match(text(r), /binary file/);
});

// --- 5. savings: byte offsets + partial-line holdback ---
const SAVER = "mcp__plugin_tokensaver_code__Search";
const pair = (rid, tid) =>
  JSON.stringify({ type: "assistant", requestId: rid, message: { model: "m", content: [{ type: "tool_use", id: tid, name: SAVER, input: {} }] } }) + "\n" +
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: tid }] } }) + "\n";

test("savings: byte offset survives non-ASCII content between scans", () => {
  const p = join(FIX, "t.jsonl");
  writeFileSync(p, JSON.stringify({ type: "assistant", requestId: "r0", message: { model: "m", content: [{ type: "text", text: "àèéù òàì" }] } }) + "\n" + pair("r1", "t1"));
  const s1 = scanTranscriptDelta(p, 0, null);
  assert.equal(s1.scan.saverCalls, 1);
  appendFileSync(p, pair("r2", "t2"));
  const s2 = scanTranscriptDelta(p, s1.byteOffset, s1.scan.maxSeenRequestId);
  assert.equal(s2.scan.saverCalls, 1); // the old char-offset bug skipped this record
});

test("savings: partial last line is held back, then counted once complete", () => {
  const p = join(FIX, "t.jsonl");
  const first = pair("r1", "t1");
  const second = pair("r2", "t2");
  writeFileSync(p, first + second.slice(0, 20)); // partial JSON tail, no \n
  const s1 = scanTranscriptDelta(p, 0, null);
  assert.equal(s1.scan.saverCalls, 1);
  assert.equal(s1.byteOffset, first.length); // did not consume the partial line
  appendFileSync(p, second.slice(20));
  const s2 = scanTranscriptDelta(p, s1.byteOffset, s1.scan.maxSeenRequestId);
  assert.equal(s2.scan.saverCalls, 1);
});

// --- 20. Omit tags [⋯] in old_string expand to the covered file span ---
test("Edit: [⋯] tag matches covered span and splices it into new_string", async () => {
  write("omit.txt", "start\nKEEP THIS MIDDLE\nend\n");
  const r = await edit({ file_path: "omit.txt", old_string: "start\n[⋯]\nend", new_string: "start\n[⋯]\nappended\nend" });
  assert.equal(read("omit.txt"), "start\nKEEP THIS MIDDLE\nappended\nend\n", text(r));
});

test("Edit: omit tag count mismatch between old and new → error", async () => {
  write("omit2.txt", "a\nb\nc\n");
  const r = await edit({ file_path: "omit2.txt", old_string: "a\n[⋯]\nc", new_string: "x\ny" });
  assert.match(text(r), /tag count mismatch/i);
});

test("Edit: omit tag with missing anchor → clean not-found, no crash", async () => {
  write("omit3.txt", "a\nb\nc\n");
  const r = await edit({ file_path: "omit3.txt", old_string: "zzz\n[⋯]\nqqq", new_string: "x\n[⋯]\ny" });
  assert.match(text(r), /not found|failed/i);
});

// --- 19. Fuzzy ambiguity: two near-identical blocks must not silently pick one ---
import { fuzzyFind } from "../src/lib/fuzzy.mjs";

test("fuzzyFind: duplicated near-identical blocks → ambiguous (undefined)", () => {
  const file = splitKeepNewline(
    "hdr\naaaX\nbbb0\nccc0\nddd0\nfiller1\nfiller2\nfiller3\nfiller4\naaaY\nbbb0\nccc0\nddd0\nftr\n",
  );
  const target = splitKeepNewline("aaaZ\nbbb0\nccc0\nddd0\n");
  const res = fuzzyFind(file, "aaaZ\nbbb0\nccc0\nddd0\n", target, splitKeepNewline("N1\nN2\nN3\nN4\n"));
  assert.equal(res, undefined);
});

// --- JSONC: commas inside string literals must survive trailing-comma stripping ---
import { stripJsonc } from "../src/router/config.mjs";

test("stripJsonc: trailing commas removed, commas inside strings kept", () => {
  const src = '{"a": "x,]", "b": [1,2,], "c": {"d": "y,}",},}';
  const parsed = JSON.parse(stripJsonc(src));
  assert.equal(parsed.a, "x,]");
  assert.equal(parsed.c.d, "y,}");
  assert.deepEqual(parsed.b, [1, 2]);
});

test("stripJsonc: comments inside strings are not stripped", () => {
  const src = '{"url": "https://example.com/a//b", "x": 1}';
  assert.equal(JSON.parse(stripJsonc(src)).url, "https://example.com/a//b");
});

// --- update-check: semver compare + cached tip + TTL refresh ---
import { isNewerVersion, updateAvailableTip, updateCheckPath } from "../src/lib/update-check.mjs";

test("isNewerVersion: strictly-greater numeric compare", () => {
  assert.equal(isNewerVersion("1.0.4", "1.0.3"), true);
  assert.equal(isNewerVersion("1.0.3", "1.0.3"), false);
  assert.equal(isNewerVersion("1.0.2", "1.0.3"), false);
  assert.equal(isNewerVersion("2.0", "1.9.9"), true);
  assert.equal(isNewerVersion(undefined, "1.0.0"), false);
  assert.equal(isNewerVersion("abc", "1.0.0"), false);
});

test("updateAvailableTip: newer cached version → tip; same → none", () => {
  const home = join(FIX, "home");
  process.env.TOKENSAVER_HOME = home;
  mkdirSync(home, { recursive: true });
  const root = join(FIX, "plugin");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), '{"version":"1.0.3"}');
  writeFileSync(updateCheckPath(), JSON.stringify({ checkedAt: Date.now(), latestVersion: "1.0.4" }));
  assert.match(updateAvailableTip(root), /v1\.0\.4.*installed v1\.0\.3/s);
  assert.match(updateAvailableTip(root), /claude plugin marketplace update/);
  assert.match(updateAvailableTip(root, { hostName: "codex" }), /codex plugin marketplace upgrade/);
  writeFileSync(updateCheckPath(), JSON.stringify({ checkedAt: Date.now(), latestVersion: "1.0.3" }));
  assert.equal(updateAvailableTip(root), undefined);
  delete process.env.TOKENSAVER_HOME;
});
