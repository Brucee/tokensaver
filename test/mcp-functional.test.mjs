import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP stdio: discovery, Search, Edit, SQLite and live settings", { timeout: 20_000 }, async () => {
  const parent = resolve(tmpdir());
  const cwd = mkdtempSync(join(parent, "ts-mcp-"));
  mkdirSync(join(cwd, "home")); mkdirSync(join(cwd, "claude"));
  writeFileSync(join(cwd, "example.txt"), "first\nneedle\n");
  writeFileSync(join(cwd, "db.sqlite"), "");
  const client = new Client({ name: "tokensaver-functional-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve("servers/code-server.mjs")], cwd,
    env: { ...process.env, TOKENSAVER_HOME: join(cwd, "home"), CLAUDE_CONFIG_DIR: join(cwd, "claude") },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data) => { stderr += data.toString(); });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["Edit", "Search", "Sql"]);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: { cwd, ...args } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.content[0].text;
    };
    assert.match(await call("Search", { file_glob_patterns: ["*.txt"], content_regex: "needle" }), /2:needle/);
    writeFileSync(join(cwd, ".gitignore"), "hidden.txt\n");
    writeFileSync(join(cwd, "hidden.txt"), "ignored payload\n");
    assert.doesNotMatch(await call("Search", { file_glob_patterns: ["*.txt"] }), /ignored payload/);
    assert.match(await call("Search", { file_glob_patterns: ["*.txt"], include_ignored: true }), /ignored payload/);
    await call("Edit", { edits: [{ file_path: "example.txt", old_string: "needle", new_string: "updated" }] });
    assert.equal(readFileSync(join(cwd, "example.txt"), "utf8"), "first\nupdated\n");
    const result = await call("Sql", { action: "query", connection_string: "sqlite:db.sqlite", sql: "SELECT 42 AS answer", format: "json-csv" });
    assert.deepEqual(JSON.parse(result.split("\n")[0]), { columns: ["answer"], rows: [["42"]] });
    const batch = await client.callTool({ name: "Sql", arguments: { action: "queries", queries: [{ sql: "SELECT 1" }, { sql: "SELECT * FROM missing" }] } });
    assert.equal(batch.isError, true);
    const timeout = await client.callTool({ name: "Sql", arguments: {
      action: "query",
      sql: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n",
      timeout_ms: 150, auto_limit: false,
    } });
    assert.equal(timeout.isError, true); assert.match(timeout.content[0].text, /timeout/i);
    assert.match(await call("Sql", { action: "query", connection_string: "sqlite:db.sqlite", sql: "SELECT 17 AS recovered" }), /recovered\n17/);
    writeFileSync(join(cwd, "home/settings.json"), '{"enabled":false}');
    const disabled = await client.callTool({ name: "Search", arguments: { cwd, file_glob_patterns: ["*.txt"] } });
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /disabled/);
    assert.equal(stderr, "");
  } finally {
    await client.close();
    const rel = relative(parent, cwd);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
