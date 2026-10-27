// node:sqlite ships with Node >= 22.16 (our engines floor), so plugin installs
// need no native build — better-sqlite3 binaries were missing from them.
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";

let db;
process.on("disconnect", () => { try { db?.close(); } finally { process.exit(0); } });
process.on("message", ({ id, action, sql, params, timeoutMs }) => {
  try {
    if (action === "open") {
      const path = process.argv[2];
      // DatabaseSync creates missing files; a typo'd path must fail instead.
      if (path !== ":memory:" && !statSync(path, { throwIfNoEntry: false })?.isFile()) {
        throw Object.assign(new Error(`unable to open database file: ${path} is not an existing SQLite file`), { code: "SQLITE_CANTOPEN" });
      }
      db = new DatabaseSync(path);
      process.send({ id, result: true });
      return;
    }
    db.exec(`PRAGMA busy_timeout = ${Math.floor(timeoutMs)}`);
    const stmt = db.prepare(sql);
    const columns = stmt.columns();
    let result;
    if (columns.length > 0) {
      const rows = stmt.all(...params);
      result = { columns: columns.map((c) => c.name), rows, rowCount: rows.length };
    } else {
      const changes = Number(stmt.run(...params).changes);
      result = { columns: ["changes"], rows: [{ changes }], rowCount: changes };
    }
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: { message: error.message, code: error.code } });
  }
});
