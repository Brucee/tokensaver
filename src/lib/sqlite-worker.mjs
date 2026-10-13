import Database from "better-sqlite3";

let db;
process.on("disconnect", () => { try { db?.close(); } finally { process.exit(0); } });
process.on("message", ({ id, action, sql, params, timeoutMs }) => {
  try {
    if (action === "open") {
      const path = process.argv[2];
      db = new Database(path, path === ":memory:" ? {} : { fileMustExist: true });
      process.send({ id, result: true });
      return;
    }
    db.pragma(`busy_timeout = ${timeoutMs}`);
    const stmt = db.prepare(sql);
    let result;
    if (stmt.reader) {
      const rows = stmt.all(...params);
      result = { columns: stmt.columns().map((c) => c.name), rows, rowCount: rows.length };
    } else {
      const info = stmt.run(...params);
      result = { columns: ["changes"], rows: [{ changes: info.changes }], rowCount: info.changes };
    }
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: { message: error.message, code: error.code } });
  }
});
