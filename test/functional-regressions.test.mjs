import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { Socket } from "node:net";
import { runSearch } from "../src/tools/search.mjs";
import { runEdit } from "../src/tools/edit.mjs";
import { runSql, closeSqlConnections } from "../src/tools/sql.mjs";
import { fuzzyFind } from "../src/lib/fuzzy.mjs";
import { splitKeepNewline } from "../src/lib/lineio.mjs";
import { classifyFile, suggestLenses } from "../src/lib/review-diff.mjs";
import { verifyFindings } from "../src/lib/review-verify.mjs";

const parent = resolve(tmpdir());
const root = mkdtempSync(join(parent, "ts-regressions-"));
const savedEnv = { ...process.env };
let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(root, "case-"));
  for (const key of Object.keys(process.env)) if (key.startsWith("TOKENSAVER_FEATURE_") || key === "TOKENSAVER_MAX_MCP_OUTPUT_TOKENS") delete process.env[key];
  process.env.TOKENSAVER_HOME = join(cwd, "settings");
  process.env.CLAUDE_CONFIG_DIR = join(cwd, "claude");
});
after(async () => {
  await closeSqlConnections();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  const rel = relative(parent, root);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  rmSync(root, { recursive: true, force: true });
});
const write = (name, body) => {
  const path = join(cwd, name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const read = (name) => readFileSync(join(cwd, name), "utf8");
const text = (r) => r.content[0].text;
const search = (args) => runSearch({ cwd, ...args });
const edit = (file_path, old_string, new_string, extra = {}) => runEdit({ cwd, edits: [{ file_path, old_string, new_string, ...extra }] });
const settings = (value) => write("settings/settings.json", JSON.stringify(value));
const policy = (value) => write("claude/settings.json", JSON.stringify({ tokensaver: { sql: value } }));
const ok = (r) => assert.notEqual(r.isError, true, text(r));
const block = "function foo() {\n  return 1;\n}\n";
const needle = block.replace("1", "2");

test("Search intersects type and glob scope", async () => {
  write("src/a.ts", "in scope"); write("src/b.js", "wrong type"); write("other/c.ts", "outside scope");
  const r = await search({ file_glob_patterns: ["src/*"], type: "ts", output_mode: "file_paths_only" });
  assert.match(text(r), /src\/a.ts/);
  assert.doesNotMatch(text(r), /b.js|c.ts/);
});
test("Search file_limit counts matching files after filtering", async () => {
  write("a.txt", "miss"); write("z.txt", "needle");
  const r = await search({ file_glob_patterns: ["*.txt"], content_regex: "needle", file_limit: 1 });
  assert.match(text(r), /z.txt/);
});
test("Search file_limit does not let binary errors hide later matches", async () => {
  write("a.txt", Buffer.from([0])); write("z.txt", "needle");
  const r = await search({ file_glob_patterns: ["*.txt"], content_regex: "needle", file_limit: 1 });
  assert.match(text(r), /z.txt/);
});
test("Search glob with ignored range still matches files", async () => {
  write("a.txt", "first\nsecond\n");
  assert.match(text(await search({ file_glob_patterns: ["*.txt#2"] })), /first/);
});
test("Search paths-only does not attach images or read binary bodies", async () => {
  write("a.png", Buffer.from([0, 1, 2]));
  const r = await search({ file_glob_patterns: ["a.png"], output_mode: "file_paths_only" });
  assert.equal(r.content.length, 1); assert.match(text(r), /a.png/); assert.doesNotMatch(text(r), /binary file/);
});
test("Search unchanged images return metadata without attachment", async () => {
  const file = write("a.png", Buffer.from([0, 1, 2]));
  utimesSync(file, new Date("2020-01-01"), new Date("2020-01-01"));
  const r = await search({ file_glob_patterns: ["a.png"], if_modified_since: "2021-01-01T00:00:00Z" });
  assert.equal(r.content.length, 1); assert.match(text(r), /unchanged/);
});
test("Search skips dependencies in broad globs but permits explicit discovery", async () => {
  write("node_modules/pkg/a.js", "dep"); write("app.js", "app");
  assert.doesNotMatch(text(await search({ file_glob_patterns: ["**/*.js"], output_mode: "file_paths_only" })), /node_modules/);
  assert.match(text(await search({ file_glob_patterns: ["node_modules/**/*.js"], output_mode: "file_paths_only" })), /pkg\/a.js/);
});
test("Search bounds path lists and reports truncation", async () => {
  process.env.TOKENSAVER_MAX_MCP_OUTPUT_TOKENS = "300";
  for (let i = 0; i < 80; i++) write(`file-${i}-${"x".repeat(20)}.txt`, "body");
  const r = await search({ file_glob_patterns: ["*.txt"], output_mode: "file_paths_only" });
  assert.ok(text(r).length <= 600); assert.match(text(r), /truncat/i);
});
test("Search handles metadata errors at the output cap without crashing", async () => {
  process.env.TOKENSAVER_MAX_MCP_OUTPUT_TOKENS = "150";
  for (let i = 0; i < 20; i++) write(`${i}.pdf`, "pdf");
  const r = await search({ file_glob_patterns: ["*.pdf"] });
  assert.ok(text(r).length <= 300);
});
test("Search rejects oversized file bodies", async () => {
  write("huge.txt", Buffer.alloc(4 * 1024 * 1024 + 1, "x"));
  assert.match(text(await search({ file_glob_patterns: ["huge.txt"] })), /4 MiB/);
});
test("Search bounds catastrophic regex execution", { timeout: 5000 }, async () => {
  write("evil.txt", "a".repeat(100_000) + "!");
  const r = await search({ file_glob_patterns: ["evil.txt"], content_regex: "(a+)+$" });
  assert.equal(r.isError, true); assert.equal(r._meta.errorCode, "SEARCH_REGEX_FAILED");
});
test("Search directory regex lists only matching descendants", async () => {
  write("src/a.txt", "miss"); write("src/deep/b.txt", "hit");
  const r = await search({ file_glob_patterns: ["src"], content_regex: "hit", output_mode: "file_paths_only" });
  assert.match(text(r), /deep\/b.txt/); assert.doesNotMatch(text(r), /a.txt/);
});
test("Edit refuses fuzzy match outside requested line range", async () => {
  const original = "a\nb\nc\n" + block;
  write("a.txt", original);
  assert.equal((await edit("a.txt#1-3", needle, "replacement\n")).isError, true);
  assert.equal(read("a.txt"), original);
});
test("Edit applies scoped fuzzy match and retains surrounding CRLF", async () => {
  write("a.txt", ("header\n" + block + "tail\n").replaceAll("\n", "\r\n"));
  const r = await edit("a.txt#2-4", needle, block.replace("1", "9"));
  ok(r); assert.equal(read("a.txt"), ("header\n" + block.replace("1", "9") + "tail\n").replaceAll("\n", "\r\n"));
});
test("Edit refuses exact replacements extending beyond scope", async () => {
  write("a.txt", block);
  assert.equal((await edit("a.txt#1-1", block, "replacement\n")).isError, true);
  assert.equal(read("a.txt"), block);
});
test("Edit replace_all never falls back to replacing one fuzzy match", async () => {
  write("a.txt", block);
  assert.equal((await edit("a.txt", needle, "replacement\n", { replace_all: true })).isError, true);
  assert.equal(read("a.txt"), block);
});
test("Edit supports replacing entire content with empty text", async () => {
  write("a.txt", "hello"); ok(await edit("a.txt", "hello", "")); assert.equal(read("a.txt"), "");
});
test("Fuzzy rejects duplicate near-perfect matches", () => {
  const target = ["const identifierLongEnough = 1;\n", "// " + "x".repeat(300) + "\n", "end\n"];
  const file = splitKeepNewline(target.join("").replace("= 1", "= 2") + "gap\n" + target.join("").replace("= 1", "= 3"));
  assert.equal(fuzzyFind(file, target.join(""), target, ["new\n"]), undefined);
});
test("Edit protects junction aliases into node_modules", async () => {
  write("node_modules/pkg/a.txt", "original");
  symlinkSync(join(cwd, "node_modules/pkg"), join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
  const r = await edit("alias/a.txt", "original", "changed");
  assert.equal(r._meta.errorCode, "EDIT_PROTECTED_PATH"); assert.equal(read("node_modules/pkg/a.txt"), "original");
});
test("Edit Windows protection ignores path case", async () => {
  if (process.platform !== "win32") return;
  write("node_modules/pkg/a.txt", "original");
  assert.equal((await edit("NODE_MODULES/pkg/a.txt", "original", "changed"))._meta.errorCode, "EDIT_PROTECTED_PATH");
});
test("Edit rejects malformed notebook overwrite and ambiguous cells", async () => {
  const nb = JSON.stringify({ cells: [{ cell_type: "code", source: ["x = 1"] }, { cell_type: "code", source: ["x = 1"] }] });
  write("n.ipynb", nb);
  assert.equal((await edit("n.ipynb", undefined, "bad json", { overwrite: true })).isError, true);
  assert.equal(read("n.ipynb"), nb);
  assert.equal((await edit("n.ipynb", "x = 1", "x = 2")).isError, true);
  assert.equal(read("n.ipynb"), nb);
});
test("Edit reports empty notebook cell selection without throwing", async () => {
  write("n.ipynb", '{"cells":[]}');
  assert.equal((await edit("n.ipynb#cell=first", "x", "y")).isError, true);
});
test("Edit global syntax setting and project/environment precedence", async () => {
  settings({ syntaxValidation: false });
  write("bad.js", "old");
  assert.doesNotMatch(text(await edit("bad.js", "old", "function broken( {")), /Syntax errors:/);
  write(".tokensaver.json", '{"syntaxValidation":true}');
  assert.match(text(await edit("bad.js", undefined, "function bad( {", { overwrite: true })), /Syntax errors:/);
  process.env.TOKENSAVER_FEATURE_SYNTAXVALIDATION = "0";
  assert.doesNotMatch(text(await edit("bad.js", undefined, "function worse( {", { overwrite: true })), /Syntax errors:/);
});
test("Disabled setting blocks all tools without modifying files", async () => {
  write("a.txt", "original"); settings({ enabled: false });
  for (const r of [await search({ file_glob_patterns: ["a.txt"] }), await edit("a.txt", "original", "changed"), await runSql({ action: "query", sql: "SELECT 1" })]) {
    assert.equal(r._meta.errorCode, "TOKENSAVER_DISABLED");
  }
  assert.equal(read("a.txt"), "original");
});
test("Disabled setting silences session hook", () => {
  settings({ enabled: false });
  const r = spawnSync(process.execPath, [resolve("scripts/session-hook.cjs")], {
    env: process.env, encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreToolUse", cwd, tool_name: "Read", tool_input: { file_path: "a.txt" } }),
  });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), "");
});
test("SQL SQLite search binds keywords and commented SELECT returns rows", async () => {
  const connection_string = `sqlite:${write("db.sqlite", "")}`;
  ok(await runSql({ connection_string, sql: "CREATE TABLE users (id INTEGER)" }));
  assert.match(text(await runSql({ action: "search", name: "user" })), /users/);
  const r = await runSql({ sql: "-- comment\nSELECT 42 AS answer", auto_limit: false });
  ok(r); assert.match(text(r), /answer\n42/);
});
test("SQL JSON output remains parseable above 1000 characters", async () => {
  const connection_string = `sqlite:${write("db.sqlite", "")}`;
  const r = await runSql({ connection_string, sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100) SELECT x, printf('%050d', x) AS value FROM n", format: "json-csv", auto_limit: false });
  ok(r); const data = JSON.parse(text(r).split("\n")[0]); assert.equal(data.rows.length, 100);
  assert.ok(text(r).length > 1000);
});
test("SQL JSON row budgets retain column alignment", async () => {
  const connection_string = `sqlite:${write("db.sqlite", "")}`;
  const r = await runSql({ connection_string, sql: "SELECT 'abcdef' AS a, 'ghijkl' AS b, 'mnop' AS c", format: "json-csv", max_line_length: 4 });
  ok(r); const data = JSON.parse(text(r).split("\n")[0]); assert.equal(data.rows[0].length, data.columns.length);
});
test("SQL cache distinguishes relative files in different working directories", async () => {
  write("a/db.sqlite", ""); write("b/db.sqlite", "");
  for (const [folder, n] of [["a", 1], ["b", 2]]) {
    const args = { cwd: join(cwd, folder), connection_string: "sqlite:db.sqlite" };
    ok(await runSql({ ...args, sql: "CREATE TABLE value (n INTEGER)" }));
    ok(await runSql({ ...args, sql: `INSERT INTO value VALUES (${n})` }));
  }
  const r = await runSql({ cwd: join(cwd, "a"), connection_string: "sqlite:db.sqlite", sql: "SELECT n FROM value" });
  ok(r); assert.match(text(r), /n\n1/);
  assert.match(text(await runSql({ sql: "SELECT n FROM value" })), /n\n1/);
});
test("SQL cached implicit connection rechecks changed policy", async () => {
  ok(await runSql({ connection_string: `sqlite:${write("db.sqlite", "")}`, sql: "SELECT 1" }));
  policy({ deny: ["local"] });
  assert.equal((await runSql({ sql: "SELECT 1" }))._meta.errorCode, "SQL_CONNECT_FAILED");
});
test("SQL policies use effective driver destinations without opening a socket", async (t) => {
  const network = t.mock.method(Socket.prototype, "connect", () => { throw new Error("Network is disabled in this test"); });
  policy({ deny: ["remote"] });
  // pg honors a host query parameter; mysql2 intentionally ignores it.
  for (const connection_string of ["postgresql://localhost/db?host=blocked.invalid", "mysql://blocked.invalid/db?host=localhost"]) {
    const r = await runSql({ action: "connect", connection_string });
    assert.equal(r.isError, true); assert.match(text(r), /blocked by policy/);
  }
  assert.equal(network.mock.callCount(), 0);
});
test("SQL partial batch failure is surfaced as an error", async () => {
  const r = await runSql({ connection_string: `sqlite:${write("db.sqlite", "")}`, action: "queries", queries: [{ name: "ok", sql: "SELECT 1" }, { name: "bad", sql: "SELECT * FROM missing" }] });
  assert.equal(r.isError, true); assert.match(text(r), /--- ok ---/); assert.match(text(r), /ERROR:/);
});
test("PostgreSQL adapter binds relationship parameters once (mock driver)", async (t) => {
  const { default: pg } = await import("pg");
  const network = t.mock.method(Socket.prototype, "connect", () => { throw new Error("Network is disabled in this test"); });
  t.mock.method(pg.Client.prototype, "connect", async () => {});
  t.mock.method(pg.Client.prototype, "end", async () => {});
  let params;
  t.mock.method(pg.Client.prototype, "query", async (query) => {
    if (typeof query === "string") return {};
    params = query.values;
    return { fields: [{ name: "from_table" }], rows: [{ from_table: "users" }], rowCount: 1 };
  });
  try {
    const r = await runSql({ connection_string: "postgresql://localhost/mock_relationships", action: "relationships", name: "users", schema: "public" });
    ok(r); assert.deepEqual(params, ["users", "public"]); assert.equal(network.mock.callCount(), 0);
  } finally { await closeSqlConnections(); }
});
test("PostgreSQL adapter evicts connections failing during timeout setup (mock driver)", async (t) => {
  const { default: pg } = await import("pg");
  const network = t.mock.method(Socket.prototype, "connect", () => { throw new Error("Network is disabled in this test"); });
  const connect = t.mock.method(pg.Client.prototype, "connect", async () => {});
  const close = t.mock.method(pg.Client.prototype, "end", async () => {});
  let fail = false;
  t.mock.method(pg.Client.prototype, "query", async (query) => {
    if (typeof query === "string") {
      if (fail) throw Object.assign(new Error("connection closed"), { code: "EPIPE" });
      return {};
    }
    return { fields: [{ name: "answer" }], rows: [{ answer: 42 }], rowCount: 1 };
  });
  try {
    const args = { connection_string: "postgresql://localhost/mock_reconnect", sql: "SELECT 42 AS answer" };
    ok(await runSql(args));
    fail = true;
    assert.equal((await runSql({ sql: args.sql })).isError, true);
    assert.equal(close.mock.callCount(), 1);
    fail = false;
    ok(await runSql(args));
    assert.equal(connect.mock.callCount(), 2); assert.equal(network.mock.callCount(), 0);
  } finally { await closeSqlConnections(); }
});
test("Review keeps distinct locations and does not use invalid canonical findings", () => {
  write("a.js", "one\ntwo\n");
  const r = verifyFindings([999, 1, 2].map((line) => `- **major** \`a.js:${line}\` (correctness) missing null check add a guard`).join("\n"), { cwd });
  assert.equal(r.summary.duplicates, 0); assert.match(r.verificationScope, /citation-only/);
});
test("Review selects three lenses only for small diffs and classifies agent instructions", () => {
  assert.equal(classifyFile("agents/review.md"), "config");
  assert.equal(classifyFile("src/agents/task.js"), "code");
  assert.equal(suggestLenses({ code: ["a.js"] }, { changedLines: 80 }).length, 3);
  assert.equal(suggestLenses({ code: ["a.js"] }, { changedLines: 81 }).length, 7);
  assert.equal(suggestLenses({ code: ["a", "b", "c", "d"] }, { changedLines: 1 }).length, 7);
});
