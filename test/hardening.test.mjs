import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { runSearch } from "../src/tools/search.mjs";
import { runSql, closeSqlConnections } from "../src/tools/sql.mjs";
import { createImportGraphCache } from "../src/lib/import-graph.mjs";
import { serializeDriver } from "../src/lib/sql-timeout.mjs";
import { normalizePath } from "../src/lib/paths.mjs";

const parent = resolve(tmpdir());
const root = mkdtempSync(join(parent, "ts-hardening-"));
const savedEnv = { ...process.env };
let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(root, "case-"));
  process.env.TOKENSAVER_HOME = join(cwd, "settings");
  process.env.CLAUDE_CONFIG_DIR = join(cwd, "claude");
  if (process.env.TEST_DUCKDB_BIN) process.env.TOKENSAVER_DUCKDB = resolve(process.env.TEST_DUCKDB_BIN);
});
afterEach(closeSqlConnections);
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  const rel = relative(parent, root);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
const write = (name, body) => {
  const path = join(cwd, name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const text = (r) => r.content[0].text;
const ok = (r) => assert.notEqual(r.isError, true, text(r));
const search = (args = {}) => runSearch({ cwd, file_glob_patterns: ["**/*"], output_mode: "file_paths_only", ...args });
const policy = (duckdb) => write("claude/settings.json", JSON.stringify({ tokensaver: { sql: { duckdb } } }));
const sql = (statement, args = {}) => runSql({ cwd, sql: statement, auto_limit: false, ...args });
const sqlite = () => `sqlite:${write("test.db", "")}`;

test("Search applies nested gitignore rules, negations, anchors and directory patterns", async () => {
  write(".gitignore", "*.log\n!keep.log\n/root.txt\ncache/\n\\!literal.txt\nfile[0-9].txt\n");
  for (const f of ["hide.log", "keep.log", "root.txt", "src/root.txt", "cache/a.txt", "src/cache/a.txt", "!literal.txt", "file1.txt", "visible.txt", "src/hidden.log", "src/keep.log"] ) write(f, "data");
  write("src/.gitignore", "!hidden.log\nkeep.log\n");
  const r = text(await search());
  for (const f of ["keep.log", "src/root.txt", "visible.txt", "src/hidden.log"]) assert.ok(r.includes("\n" + f + "\n"), r);
  for (const f of ["hide.log", "root.txt", "cache/a.txt", "src/cache/a.txt", "!literal.txt", "file1.txt", "src/keep.log"]) assert.ok(!r.includes("\n" + f + "\n"), r);
});

test("Search cannot reinclude a file under an excluded parent directory", async () => {
  write(".gitignore", "build/\n!build/keep.txt\n"); write("build/keep.txt", "hidden");
  write("build/.gitignore", "!keep.txt\n");
  for (const pattern of ["**/*", "build/**/*", "build", "build/*"]) {
    assert.doesNotMatch(text(await search({ file_glob_patterns: [pattern] })), /keep\.txt/);
  }
});

test("Search permits literal ignored files and explicit include_ignored", async () => {
  write(".gitignore", "build/\n"); write("build/keep.txt", "explicit content");
  assert.match(text(await search({ file_glob_patterns: ["build/keep.txt"], output_mode: "file_paths_with_content" })), /explicit content/);
  assert.match(text(await search({ include_ignored: true })), /build\/keep.txt/);
});

test("Search directory listings and content scans both respect gitignore", async () => {
  write(".gitignore", "hidden.txt\n"); write("hidden.txt", "needle"); write("shown.txt", "needle");
  assert.doesNotMatch(text(await search({ file_glob_patterns: ["."] })), /hidden.txt/);
  assert.doesNotMatch(text(await search({ file_glob_patterns: ["."], content_regex: "needle", output_mode: "file_paths_with_content" })), /hidden.txt/);
});

test("Search reloads changed ignore rules on the next call", async () => {
  write("a.txt", "data"); write(".gitignore", "a.txt\n");
  assert.doesNotMatch(text(await search()), /a.txt/);
  write(".gitignore", "");
  assert.match(text(await search()), /a.txt/);
});

test("Search inherits repository ignore rules when cwd is a subdirectory", async () => {
  mkdirSync(join(cwd, ".git"));
  write(".gitignore", "*.log\n"); write("sub/a.log", "hidden"); write("sub/a.txt", "visible");
  const r = text(await search({ cwd: join(cwd, "sub") }));
  assert.doesNotMatch(r, /a.log/); assert.match(r, /a.txt/);
});

test("Search importers exclude ignored sources and invalidate on ignore changes", async () => {
  write("dep.ts", "export const dep = 1;"); write("caller.ts", "import { dep } from './dep';");
  write(".gitignore", "caller.ts\n");
  const args = { file_glob_patterns: ["dep.ts"], list_importers: true, output_mode: "file_paths_with_content" };
  assert.doesNotMatch(text(await search(args)), /caller.ts/);
  write(".gitignore", "");
  assert.match(text(await search(args)), /caller.ts/);
  write(".gitignore", "caller.ts\n");
  assert.doesNotMatch(text(await search(args)), /caller.ts/);
});

test("Import cache avoids reading unchanged sources and reuses the graph", () => {
  const dep = write("dep.ts", "export const value = 1;");
  const caller = write("caller.ts", "import { value } from './dep';");
  let reads = 0;
  const build = createImportGraphCache({ readFile: (...args) => { reads++; return readFileSync(...args); } });
  const first = build(cwd, [dep, caller]);
  assert.equal(reads, 2);
  assert.deepEqual([...first.get(normalizePath(dep))], [caller]);
  assert.equal(build(cwd, [dep, caller]), first);
  assert.equal(reads, 2);
  write("caller.ts", "export const unrelated = true;");
  assert.equal(build(cwd, [dep, caller]).has(normalizePath(dep)), false);
  assert.equal(reads, 3);
});

test("Import cache detects added and deleted targets without rereading importers", () => {
  const caller = write("caller.ts", "import './later';");
  let reads = 0;
  const build = createImportGraphCache({ readFile: (...args) => { reads++; return readFileSync(...args); } });
  assert.equal(build(cwd, [caller]).size, 0);
  const target = write("later/index.ts", "export {};");
  assert.ok(build(cwd, [caller]).get(normalizePath(target)).has(caller));
  assert.equal(reads, 1);
  rmSync(target);
  assert.equal(build(cwd, [caller]).size, 0);
});

test("Import cache removes deleted importers and invalidates preserved mtime edits", () => {
  const a = write("a.ts", "export {};"); const b = write("b.ts", "export {};");
  const caller = write("caller.ts", "import './a';"); const st = statSync(caller);
  const build = createImportGraphCache();
  assert.ok(build(cwd, [caller]).has(normalizePath(a)));
  write("caller.ts", "import './b';"); utimesSync(caller, st.atime, st.mtime);
  assert.ok(build(cwd, [caller]).has(normalizePath(b)));
  assert.equal(build(cwd, []).size, 0);
});

test("Import cache enforces root LRU and per-project bounds without dropping results", () => {
  const a = write("a.ts", "import './b';"); const b = write("b.ts", "import './a';");
  let reads = 0;
  const build = createImportGraphCache({ maxRoots: 1, maxFiles: 1, readFile: (...args) => { reads++; return readFileSync(...args); } });
  assert.equal(build(cwd, [a, b]).size, 2);
  assert.equal(build(cwd, [a, b]).size, 2);
  assert.equal(reads, 3);
  build(join(cwd, "other"), []);
  build(cwd, [a, b]); assert.equal(reads, 5);
});

test("Sql rejects invalid timeout values before connecting", async () => {
  for (const timeout_ms of [0, -1, 1.5, Infinity, 2147483648]) {
    const r = await sql("SELECT 1", { timeout_ms });
    assert.equal(r._meta.errorCode, "SQL_BAD_ARGS");
  }
});

test("SQLite interrupts CPU-bound SQL, stays responsive, rolls back and reconnects", { timeout: 15000 }, async () => {
  const connection_string = sqlite();
  ok(await sql("CREATE TABLE records (value INTEGER)", { connection_string }));
  ok(await sql("BEGIN")); ok(await sql("INSERT INTO records VALUES (7)"));
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  const start = performance.now();
  let result;
  try {
    result = await sql("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n", { timeout_ms: 150 });
  } finally { clearInterval(heartbeat); }
  assert.equal(result._meta?.errorCode, "SQL_TIMEOUT", text(result));
  assert.ok(performance.now() - start < 5000);
  assert.ok(ticks > 0, "server event loop must remain responsive");
  assert.equal((await sql("SELECT 1"))._meta?.errorCode, "SQL_CONNECT_FAILED");
  const recovered = await sql("SELECT count(*) AS total FROM records", { connection_string });
  ok(recovered); assert.match(text(recovered), /total\n0\n/);
});

test("SQLite concurrent first connections share one in-memory database", async () => {
  const connection_string = "sqlite::memory:";
  const results = await Promise.all([
    sql("CREATE TABLE items (id INTEGER)", { connection_string }),
    sql("INSERT INTO items VALUES (9)", { connection_string }),
  ]);
  results.forEach(ok);
  assert.match(text(await sql("SELECT id FROM items")), /id\n9\n/);
});

test("SQL driver serializes timeout settings with their statements", async () => {
  const calls = [];
  const driver = serializeDriver({
    async setTimeoutMs(ms) { calls.push(ms); },
    async query(sql) { await new Promise((done) => setTimeout(done, 10)); calls.push(sql); return {}; },
    async close() {},
  });
  await Promise.all([driver.execute("first", [], 200), driver.execute("second", [], 300)]);
  assert.deepEqual(calls, [200, "first", 300, "second"]);
});

test("SQL deadline also interrupts a stalled timeout-setting request", async () => {
  let aborted = false, queried = false;
  const driver = serializeDriver({
    setTimeoutMs: () => new Promise(() => {}),
    query() { queried = true; }, abort() { aborted = true; }, async close() {},
  });
  await assert.rejects(driver.execute("query", [], 30), { code: "SQL_TIMEOUT" });
  assert.equal(aborted, true); assert.equal(queried, false);
  await assert.rejects(driver.execute("later", [], 30), { code: "CONNECTION_ENDED" });
});

test("MySQL uses MariaDB timeout fallback and closes stalled queries without network", async (t) => {
  const { default: mysql } = await import("mysql2");
  const network = t.mock.method(Socket.prototype, "connect", () => { throw new Error("Unexpected network connection"); });
  const raw = new EventEmitter();
  let destroyed = false, stall = false;
  const calls = [];
  raw.connect = (callback) => callback();
  raw.destroy = () => { destroyed = true; };
  raw.promise = () => ({
    async query(statement) {
      calls.push(statement);
      if (statement.startsWith("SET SESSION MAX_EXECUTION_TIME")) throw Object.assign(new Error("unknown variable"), { code: "ER_UNKNOWN_SYSTEM_VARIABLE" });
      if (statement.startsWith("SET SESSION max_statement_time")) return [];
      if (stall) return new Promise(() => {});
      return [[{ answer: 42 }], [{ name: "answer" }]];
    }, async end() {}, destroy: raw.destroy,
  });
  t.mock.method(mysql, "createConnection", () => raw);
  try {
    ok(await sql("SELECT 42", { connection_string: "mysql://localhost/mock", timeout_ms: 500 }));
    assert.deepEqual(calls.slice(0, 3), ["SET SESSION MAX_EXECUTION_TIME=500", "SET SESSION max_statement_time=0.5", "SELECT 42"]);
    stall = true;
    const result = await sql("SELECT 42", { timeout_ms: 30 });
    assert.equal(result._meta?.errorCode, "SQL_TIMEOUT", text(result));
    assert.equal(destroyed, true); assert.equal(network.mock.callCount(), 0);
  } finally { await closeSqlConnections(); }
});

test("MySQL connection deadline terminates a stalled handshake without network", async (t) => {
  const { default: mysql } = await import("mysql2");
  const network = t.mock.method(Socket.prototype, "connect", () => { throw new Error("Unexpected network connection"); });
  const raw = new EventEmitter();
  let destroyed = false;
  raw.connect = () => {};
  raw.destroy = () => { destroyed = true; };
  t.mock.method(mysql, "createConnection", () => raw);
  const r = await sql("SELECT 1", { connection_string: "mysql://localhost/stalled", timeout_ms: 30 });
  assert.equal(r.isError, true); assert.match(text(r), /timeout/);
  assert.equal(destroyed, true); assert.equal(network.mock.callCount(), 0);
});

test("PostgreSQL native cancellation is reported as timeout and never retried", async (t) => {
  const { default: pg } = await import("pg");
  const network = t.mock.method(Socket.prototype, "connect", () => { throw new Error("Unexpected network connection"); });
  t.mock.method(pg.Client.prototype, "connect", async () => {});
  t.mock.method(pg.Client.prototype, "end", async () => {});
  let statements = 0;
  t.mock.method(pg.Client.prototype, "query", async (query) => {
    if (typeof query === "string") return {};
    statements++;
    throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  });
  try {
    const r = await sql("SELECT `name` FROM people", { connection_string: "postgresql://localhost/mock" });
    assert.equal(r._meta?.errorCode, "SQL_TIMEOUT", text(r));
    assert.equal(statements, 1); assert.equal(network.mock.callCount(), 0);
  } finally { await closeSqlConnections(); }
});

test("DuckDB rejects malformed allowlists and obsolete fileWrites opt-in", async () => {
  for (const config of [{ allowedDirectories: "C:/" }, { allowedDirectories: [42] }, { fileWrites: "false" }, { mystery: true }, { fileWrites: true }]) {
    policy(config);
    const r = await sql("SELECT 1", { connection_string: "duckdb::memory:" });
    assert.equal(r.isError, true, JSON.stringify(config));
  }
});

const duckTest = (name, fn) => test(name, { skip: !process.env.TEST_DUCKDB_BIN && "Set TEST_DUCKDB_BIN to an official DuckDB CLI", timeout: 15000 }, fn);
const duck = (statement, args = {}) => sql(statement, { connection_string: `duckdb:${join(cwd, "test.duckdb")}`, ...args });
const literal = (s) => "'" + s.replace(/'/g, "''").replace(/\\/g, "/") + "'";

duckTest("DuckDB safe mode preserves main-database queries and introspection", async () => {
  ok(await duck("CREATE TABLE people (id INTEGER, name VARCHAR)"));
  ok(await duck("INSERT INTO people VALUES (1, 'Ada')"));
  assert.match(text(await duck("SELECT * FROM people")), /1,Ada/);
  assert.match(text(await duck(undefined, { action: "tables" })), /people/);
  assert.match(text(await duck(undefined, { action: "search", name: "people" })), /name/);
  const settings = await duck("SELECT current_setting('allowed_directories') AS dirs, current_setting('allowed_paths') AS paths, current_setting('enable_external_access') AS external_access, current_setting('lock_configuration') AS locked", { format: "json-csv", max_col_width: 0, max_line_length: 0 });
  ok(settings);
  const [dirs, paths, external, locked] = JSON.parse(text(settings).split("\n")[0]).rows[0];
  assert.equal(dirs, "[]"); assert.equal(external, "false"); assert.equal(locked, "true");
  const database = normalizePath(join(cwd, "test.duckdb"));
  assert.deepEqual(JSON.parse(paths).sort(), [database, database + ".wal", database + ".wal.checkpoint", database + ".wal.recovery"].sort());
});

duckTest("DuckDB rejects external reads, writes, ATTACH and re-enabling external access", async () => {
  const source = write("private.csv", "secret\n123\n");
  const output = join(cwd, "export.csv");
  const attached = join(cwd, "attached.duckdb");
  const statements = [
    `SELECT * FROM read_csv(${literal(source)})`,
    `SELECT * FROM read_text(${literal(source)})`,
    `SELECT * FROM glob(${literal(join(cwd, "*.csv"))})`,
    `COPY (SELECT 1) /* bypass old regex */ TO ${literal(output)} (FORMAT CSV)`,
    `ATTACH /* comment */ ${literal(attached)} AS extra`,
    "SET enable_external_access=true",
    `SET allowed_directories=[${literal(cwd)}]`,
    `SET allowed_paths=[${literal(source)}]`,
    "RESET lock_configuration",
    "SET lock_configuration=false",
    `LOAD ${literal(join(cwd, "forbidden.duckdb_extension"))}`,
    "INSTALL httpfs",
    ".shell echo forbidden",
  ];
  for (const statement of statements) {
    const r = await duck(statement);
    assert.equal(r.isError, true, statement + "\n" + text(r));
  }
  assert.equal(existsSync(output), false); assert.equal(existsSync(attached), false);
  assert.equal(readFileSync(source, "utf8"), "secret\n123\n");
});

duckTest("DuckDB rechecks allowlists on cached connections", async () => {
  const external = mkdtempSync(join(root, "external-"));
  const connection_string = `duckdb:${join(external, "db.duckdb")}`;
  policy({ allowedDirectories: [external] });
  ok(await duck("SELECT 1", { connection_string }));
  policy({ allowedDirectories: [] });
  assert.equal((await duck("SELECT 1", { connection_string })).isError, true);
});

duckTest("DuckDB terminates expensive queries and can reconnect afterwards", async () => {
  ok(await duck("SELECT 1"));
  const start = performance.now();
  const r = await duck("SELECT sum(sin(a.i+b.i)) FROM range(1000000) a(i), range(1000000) b(i)", { timeout_ms: 150 });
  assert.equal(r._meta?.errorCode, "SQL_TIMEOUT", text(r));
  assert.ok(performance.now() - start < 5000);
  ok(await duck("SELECT 42"));
});
