import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSql } from "../src/tools/sql.mjs";

const FIX = join(tmpdir(), "tokensaver-sql-fixture");
mkdirSync(FIX, { recursive: true });
const DB = join(FIX, "test.db");
const text = (r) => r.content[0].text;
const cs = () => `sqlite:${DB}`;
const seed = () => {};

before(async () => {
  rmSync(DB, { force: true });
  writeFileSync(DB, ""); // sqlite connections require the file to exist
  await runSql({ action: "query", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)", connection_string: cs() });
  await runSql({ action: "query", sql: "INSERT INTO users (name, age) VALUES ('alice', 30), ('bob', 25), ('carol', 40)", connection_string: cs() });
  await runSql({ action: "query", sql: "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), total REAL)", connection_string: cs() });
});

test("Sql: connect + query csv with row footer", async () => {
  await seed();
  const r = await runSql({ action: "connect", connection_string: cs() });
  assert.ok(text(r).includes("connected: sqlite"));
  const q = await runSql({ action: "query", sql: "SELECT * FROM users" });
  const t = text(q);
  assert.ok(t.includes("id,name,age"));
  assert.ok(t.includes("1,alice,30"));
  assert.ok(t.includes("(3 rows)"));
  assert.ok(t.includes("appended LIMIT 500 to unbounded SELECT"));
});

test("Sql: auto_limit disabled", async () => {
  await seed();
  const q = await runSql({ action: "query", sql: "SELECT * FROM users", auto_limit: false });
  assert.ok(!text(q).includes("appended LIMIT"));
});

test("Sql: explicit LIMIT not double-appended", async () => {
  await seed();
  const q = await runSql({ action: "query", sql: "SELECT * FROM users LIMIT 1" });
  assert.ok(!text(q).includes("appended LIMIT"));
  assert.ok(text(q).includes("(1 row)"));
});

test("Sql: max_rows truncates with footer", async () => {
  await seed();
  const q = await runSql({ action: "query", sql: "SELECT * FROM users", max_rows: 2, auto_limit: false });
  assert.ok(text(q).includes("(showing 2 of 3 rows)"));
});

test("Sql: table format renders grid", async () => {
  await seed();
  const q = await runSql({ action: "query", sql: "SELECT name, age FROM users ORDER BY age", format: "table" });
  assert.ok(text(q).includes("|"));
  assert.ok(text(q).includes("---+"));
});

test("Sql: json-csv columns/rows shape", async () => {
  await seed();
  const q = await runSql({ action: "query", sql: "SELECT id FROM users LIMIT 1", format: "json-csv" });
  const obj = JSON.parse(text(q).split("\n")[0]);
  assert.deepEqual(obj.columns, ["id"]);
  assert.equal(obj.rows[0][0], "1");
});

test("Sql: tables introspection", async () => {
  await seed();
  const r = await runSql({ action: "tables" });
  const t = text(r);
  assert.ok(t.includes("users"));
  assert.ok(t.includes("orders"));
});

test("Sql: table columns via pragma", async () => {
  await seed();
  const r = await runSql({ action: "table", name: "users" });
  const t = text(r);
  assert.ok(t.includes("name"));
  assert.ok(t.includes("INTEGER"));
});

test("Sql: queries batch with labels", async () => {
  await seed();
  const r = await runSql({
    action: "queries",
    queries: [
      { name: "count_users", sql: "SELECT count(*) AS n FROM users" },
      { name: "max_age", sql: "SELECT max(age) AS m FROM users" },
    ],
  });
  const t = text(r);
  assert.ok(t.includes("--- count_users ---"));
  assert.ok(t.includes("--- max_age ---"));
});

test("Sql: lint catches unbalanced parens", async () => {
  const r = await runSql({ action: "lint", sql: "SELECT (1 + 2" });
  assert.ok(text(r).includes("unclosed"));
});

test("Sql: bad args errors", async () => {
  const r = await runSql({ action: "query" });
  assert.equal(r._meta.errorCode, "SQL_BAD_ARGS");
});
