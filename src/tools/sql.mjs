// Sql tool: persistent connections + schema introspection + bounded query
// output across PostgreSQL, MySQL/MariaDB, SQLite and DuckDB.
// Actions: connect, query, queries, tables, table, functions, function,
// enums, types, relationships, search, lint.
import { resolve, sep } from "node:path";
import { mcpText, mcpError } from "../lib/errors.mjs";
import { enforceSqlPolicy, duckdbPolicy } from "../lib/sql-policy.mjs";
import { loadSettings } from "../lib/config.mjs";
import { canonicalPath } from "../lib/paths.mjs";
import { openSqliteProcess } from "../lib/sqlite-process.mjs";
import { sqlDeadline, serializeDriver } from "../lib/sql-timeout.mjs";
import { duckdbDriver } from "../lib/duckdb-driver.mjs";

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_COL_WIDTH = 60;
const DEFAULT_MAX_LINE_LENGTH = 1000;
const INTERNAL_LIMIT = 3000;
const PG_EXCLUDED = "'pg_catalog','information_schema','pg_toast'";
const MYSQL_EXCLUDED = ["mysql", "sys", "information_schema", "performance_schema"];
const MYSQL_EXCLUDED_SQL = `'${MYSQL_EXCLUDED.join("','")}'`;
// MySQL table_schema == database name: default scope is the connected database
// (DATABASE() NULL means no db in the connection string → show all minus system).
const MYSQL_SCOPE = "TABLE_SCHEMA NOT IN (" + MYSQL_EXCLUDED_SQL + ") AND (DATABASE() IS NULL OR TABLE_SCHEMA = DATABASE())";

// ---------- output formatting (upstream-compatible) ----------

const cellString = (v) => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return typeof v === "string" ? v : "";
};
const truncCell = (s, w) => (!w || s.length <= w ? s : s.slice(0, w - 1) + "…");
const truncLine = truncCell;
const maxVisualWidth = (s) => Math.max(...s.split("\n").map((l) => l.length));

function rowsFooter(rowCount, shown, truncated, exact = true) {
  if (truncated) {
    return exact ? `(showing ${shown} of ${rowCount} rows)` : `(showing first ${shown} rows; more available)`;
  }
  return `(${rowCount} ${rowCount === 1 ? "row" : "rows"})`;
}

const csvCell = (v, w) => {
  const s = truncCell(cellString(v), w);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function formatCsv({ columns, rows, rowCount, truncated, rowCountExact }, maxColWidth) {
  const lines = [];
  if (columns.length > 0) lines.push(columns.map((c) => csvCell(c, maxColWidth)).join(","));
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c], maxColWidth)).join(","));
  lines.push(rowsFooter(rowCount, rows.length, truncated, rowCountExact));
  return lines.join("\n");
}

function formatJsonCsv({ columns, rows, rowCount, truncated, rowCountExact }, maxColWidth, maxLineLength) {
  const budgeted = rows.map((r) => {
    const cells = columns.map((c) => truncCell(cellString(r[c]), maxColWidth));
    if (!maxLineLength) return cells;
    const out = [];
    let used = 0;
    for (const c of cells) {
      const room = maxLineLength - used;
      if (room <= 0) { out.push(""); continue; }
      if (c.length <= room) {
        out.push(c);
        used += c.length;
      } else {
        out.push(truncLine(c, room));
        used = maxLineLength;
      }
    }
    return out;
  });
  return JSON.stringify({ columns, rows: budgeted }) + "\n" + rowsFooter(rowCount, rows.length, truncated, rowCountExact);
}

function formatTable({ columns, rows, rowCount, truncated, rowCountExact }, maxColWidth) {
  if (rows.length === 0) {
    return columns.length > 0 ? `(${columns.join(", ")})\n(0 rows)` : "(0 rows)";
  }
  const cellRows = rows.map((r) => columns.map((c) => cellString(r[c])));
  const cap = maxColWidth > 0 ? maxColWidth : Infinity;
  const widths = columns.map((c, i) => {
    let w = c.length;
    for (const row of cellRows) w = Math.max(w, Math.min(maxVisualWidth(row[i]), cap));
    return w;
  });
  const pad = (s, w) => {
    const t = truncCell(s, w);
    return s.includes("\n") ? s.split("\n").map((l) => truncCell(l, w)).join("\n") : t.padEnd(w);
  };
  const header = " " + columns.map((c, i) => c.padEnd(widths[i])).join(" | ") + " ";
  const sep = widths.map((w) => "-".repeat(w + 2)).join("+");
  const body = cellRows.map((r) => " " + r.map((c, i) => pad(c, widths[i])).join(" | ") + " ");
  return [header, sep, ...body, rowsFooter(rowCount, rows.length, truncated, rowCountExact)].join("\n");
}

function formatResult(result, { format = "csv", maxColWidth = DEFAULT_MAX_COL_WIDTH, maxLineLength = DEFAULT_MAX_LINE_LENGTH }) {
  let out;
  if (format === "json-csv") return formatJsonCsv(result, maxColWidth, maxLineLength);
  else if (format === "table") out = formatTable(result, maxColWidth);
  else out = formatCsv(result, maxColWidth);
  return maxLineLength ? out.split("\n").map((l) => truncLine(l, maxLineLength)).join("\n") : out;
}

// ---------- auto-limit ----------

function applyAutoLimit(sql, limit) {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^\s*(with\s|select\s)/i.test(trimmed)) return { sql };
  if (/\blimit\s+\d+/i.test(trimmed)) return { sql };
  if (/\boffset\s+\d+/i.test(trimmed)) return { sql };
  if (/\b(union|intersect|except)\b/i.test(trimmed)) return { sql };
  if (/^\s*with\s/i.test(trimmed)) {
    const finalKw = cteFinalKeyword(trimmed);
    if (finalKw && !/^select$/i.test(finalKw)) return { sql };
  }
  return { sql: trimmed + "\nLIMIT " + limit, note: `appended LIMIT ${limit} to unbounded SELECT (pass auto_limit:false to disable)` };
}

function cteFinalKeyword(sql) {
  let i = sql.search(/\bwith\b/i);
  if (i < 0) return;
  i += 4;
  const n = sql.length;
  while (i < n) {
    while (i < n && /\s|,/.test(sql[i])) i++;
    while (i < n && /[\w"]/.test(sql[i])) i++;
    while (i < n && sql[i] !== "(" && sql[i] !== ";") i++;
    if (i >= n || sql[i] === ";") return;
    let depth = 1;
    for (i++; i < n && depth > 0; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
    }
    while (i < n && /\s/.test(sql[i])) i++;
    if (i >= n) return;
    if (/[,)]/.test(sql[i])) continue;
    const rest = sql.slice(i);
    const m = /^\w+/.exec(rest);
    return m?.[0];
  }
}

// ---------- auto-fixer (Postgres) ----------

const PG_RESERVED = new Set(["do", "user", "order", "group", "table", "select", "where", "from", "join", "on", "as", "with", "case", "end", "when", "then", "else", "and", "or", "not", "null", "true", "false"]);

const pgFixers = [
  {
    description: "wrapped reserved-word alias in double-quotes",
    apply: (sql) => {
      const re = new RegExp(`\\b(from|join)\\s+([a-z_][\\w.]*)\\s+(?:as\\s+)?(${[...PG_RESERVED].join("|")})\\b`, "gi");
      let hit = false;
      const out = sql.replace(re, (_m, kw, tbl, alias) => {
        hit = true;
        return `${kw} ${tbl} AS "${alias}"`;
      });
      return hit ? out : undefined;
    },
  },
  {
    description: "replaced MySQL-style backtick identifiers with Postgres double-quotes",
    apply: (sql) => (sql.includes("`") ? sql.replace(/`([^`]+)`/g, '"$1"') : undefined),
  },
  {
    description: "rewrote date_trunc(\"part\", ...) with double-quotes to date_trunc('part', ...) (Postgres uses single-quoted strings)",
    apply: (sql) => {
      const re = /"(year|quarter|month|week|day|hour|minute|second|microsecond|millisecond|decade|century|millennium)"/gi;
      return re.test(sql) ? sql.replace(re, "'$1'") : undefined;
    },
  },
  {
    description: "rewrote count(DISTINCT a, b, ...) to count(DISTINCT (a, b, ...)) (Postgres needs parens to treat args as a tuple)",
    apply: (sql) => {
      const re = /\bcount\s*\(\s*distinct\s+([^()]+?)\s*\)/gi;
      let hit = false;
      const out = sql.replace(re, (m, inner) => (inner.includes(",") ? (hit = true, `count(DISTINCT (${inner.trim()}))`) : m));
      return hit ? out : undefined;
    },
  },
  {
    description: "round(double precision, integer) requires a numeric cast — rewrote round(X, N) → round(X::numeric, N)",
    apply: (sql) => {
      const re = /\bround\s*\(\s*([^,()]+?)\s*,\s*(\d+)\s*\)/gi;
      return re.test(sql) ? sql.replace(re, (_m, x, n) => `round(${x.trim()}::numeric, ${n})`) : undefined;
    },
  },
];

// ---------- drivers ----------

const connections = new Map(); // dialect + resolved database/host -> connection
const connecting = new Map();
let lastConnection;

export async function closeSqlConnections() {
  await Promise.allSettled([...connecting.values()]);
  const active = [...connections.values()];
  connections.clear();
  lastConnection = undefined;
  await Promise.allSettled(active.map((entry) => entry.driver.close()));
}

const isConnError = (e) =>
  /SQL_TIMEOUT|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|CONNECTION_ENDED/i.test(e?.code ?? "") ||
  /connection (is )?(closed|lost|terminated|ended)|server closed the connection|socket hang up/i.test(e?.message ?? "");

function detectDialect(cs) {
  const s = cs.toLowerCase();
  if (s.startsWith("postgresql://") || s.startsWith("postgres://")) return "postgres";
  if (s.startsWith("mysql://") || s.startsWith("mariadb://")) return "mysql";
  if (s.startsWith("sqlite:")) return "sqlite";
  if (s.startsWith("duckdb:")) return "duckdb";
  if (!s.includes("://") && /\.(sqlite3?|db)$/.test(s)) return "sqlite";
  if (!s.includes("://") && /\.(duckdb|ddb)$/.test(s)) return "duckdb";
  return undefined;
}

const sqlitePath = (cs) => cs.replace(/^sqlite:(\/\/)?/, "");
const duckdbPath = (cs) => cs.replace(/^duckdb:(\/\/)?/, "");

function checkedDuckPolicy(dbPath, cwd) {
  const duck = duckdbPolicy();
  if (duck.fileWrites === true) throw new Error("DuckDB fileWrites:true is no longer supported: safe mode blocks external file access. Export through tool results instead.");
  const fold = (p) => process.platform === "win32" ? p.toLowerCase() : p;
  const allowedDirs = [cwd, ...(Array.isArray(duck.allowedDirectories) ? duck.allowedDirectories : [])]
    .map((d) => fold(canonicalPath(resolve(cwd, d))));
  const target = dbPath === ":memory:" ? dbPath : fold(canonicalPath(dbPath));
  if (dbPath !== ":memory:" && !allowedDirs.some((d) => target.startsWith(d.endsWith(sep) ? d : d + sep) || target === d)) {
    throw new Error("DuckDB database file is outside the working directory and allowedDirectories.");
  }
  return duck;
}

async function connectDriver(connectionString, dialectOverride, cwd, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const dialect = dialectOverride ?? detectDialect(connectionString);
  if (!dialect) {
    throw new Error(`unrecognized connection_string scheme — expected postgresql://, mysql://, sqlite: or duckdb:`);
  }
  let host;
  let pgClient;
  if (dialect === "postgres") {
    const { default: pg } = await import("pg");
    pgClient = new pg.Client({ connectionString, connectionTimeoutMillis: timeoutMs });
    host = pgClient.host;
  } else if (dialect === "mysql") {
    const { default: mysql } = await import("mysql2");
    const config = new mysql.ConnectionConfig(connectionString);
    host = config.socketPath ?? config.host;
  }
  host = typeof host === "string" ? host.replace(/^\[|\]$/g, "").toLowerCase() : undefined;
  enforceSqlPolicy(dialect, host); // before the cache: policy may have changed
  const file = dialect === "sqlite" ? sqlitePath(connectionString) : dialect === "duckdb" ? duckdbPath(connectionString) : undefined;
  const databasePath = file == null || file === ":memory:" ? file : canonicalPath(resolve(cwd ?? process.cwd(), file));
  const cacheKey = JSON.stringify([dialect, databasePath ?? connectionString, host]);
  const cached = connections.get(cacheKey);
  if (cached) { lastConnection = cached; return cached; }
  if (connecting.has(cacheKey)) return connecting.get(cacheKey);
  const opening = (async () => {
    let driver;
    if (dialect === "postgres") {
      const client = pgClient;
      client.on("error", () => {}); // swallow idle errors — next query reports it
      await sqlDeadline(() => client.connect(), timeoutMs, () => client.connection?.stream?.destroy());
      driver = {
        async query(sql, params) {
          const res = await client.query({ text: sql, values: params });
          return { columns: res.fields?.map((f) => f.name) ?? [], rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
        },
        async setTimeoutMs(ms) {
          await client.query(`SET statement_timeout = ${Math.floor(ms)}`);
        },
        async close() { await client.end(); },
        abort() { client.connection?.stream?.destroy(); },
      };
    } else if (dialect === "mysql") {
      const { default: mysql } = await import("mysql2");
      const raw = mysql.createConnection({ uri: connectionString, connectTimeout: timeoutMs });
      raw.on("error", () => {});
      try {
        await sqlDeadline(() => new Promise((done, reject) => raw.connect((error) => error ? reject(error) : done())), timeoutMs, () => raw.destroy());
      } catch (error) { raw.destroy(); throw error; }
      const conn = raw.promise();
      driver = {
        async query(sql, params) {
          const [rows, fields] = await conn.query(sql, params);
          const columns = Array.isArray(fields) && fields.length ? fields.map((f) => f.name) : (rows?.[0] ? Object.keys(rows[0]) : []);
          return { columns, rows: Array.isArray(rows) ? rows : [rows], rowCount: rows?.length ?? 0 };
        },
        async setTimeoutMs(ms) {
          try { await conn.query(`SET SESSION MAX_EXECUTION_TIME=${ms}`); }
          catch (error) {
            if (error.code !== "ER_UNKNOWN_SYSTEM_VARIABLE") throw error;
            // MariaDB uses seconds and covers more statement types than MySQL.
            try { await conn.query(`SET SESSION max_statement_time=${ms / 1000}`); }
            catch (fallback) { if (fallback.code !== "ER_UNKNOWN_SYSTEM_VARIABLE") throw fallback; }
          }
        },
        async close() { await conn.end(); },
        abort() { conn.destroy(); },
      };
    } else if (dialect === "sqlite") {
      driver = await openSqliteProcess(databasePath, timeoutMs);
    } else if (dialect === "duckdb") {
      const dbPath = databasePath;
      const connectionCwd = resolve(cwd ?? process.cwd());
      checkedDuckPolicy(dbPath, connectionCwd);
      driver = duckdbDriver(dbPath, () => checkedDuckPolicy(dbPath, connectionCwd));
    }
    const entry = { dialect, driver: serializeDriver(driver), connectionString, host, cacheKey };
    connections.set(cacheKey, entry);
    lastConnection = entry;
    return entry;
  })();
  connecting.set(cacheKey, opening);
  try { return await opening; }
  finally { connecting.delete(cacheKey); }
}

async function currentConnection(args) {
  if (args.connection_string) {
    return connectDriver(args.connection_string, args.dialect, args.cwd, args.timeout_ms);
  }
  if (lastConnection) {
    enforceSqlPolicy(lastConnection.dialect, lastConnection.host);
    return lastConnection;
  }
  throw new Error("no active connection — pass connection_string once (it stays connected for the session)");
}

// ---------- introspection queries ----------

const INTROSPECT = {
  postgres: {
    tables: (schema) =>
      schema
        ? `SELECT table_schema AS schema_name, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema = $1 ORDER BY table_name LIMIT 500`
        : `SELECT table_schema AS schema_name, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN (${PG_EXCLUDED}) ORDER BY table_schema, table_name LIMIT 500`,
    tablesParams: (schema) => (schema ? [schema] : []),
    table: (schema) =>
      schema
        ? `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = $2 ORDER BY ordinal_position`
        : `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY table_schema, ordinal_position`,
    search: (schema) =>
      `SELECT t.table_schema, t.table_name, c.column_name, c.data_type, c.is_nullable
       FROM information_schema.tables t
       JOIN information_schema.columns c ON c.table_schema = t.table_schema AND c.table_name = t.table_name
       WHERE t.table_type = 'BASE TABLE'
         ${schema ? "AND t.table_schema = $2" : `AND t.table_schema NOT IN (${PG_EXCLUDED})`}
         AND (t.table_name ILIKE ANY($1) OR c.column_name ILIKE ANY($1))
       ORDER BY t.table_schema, t.table_name, c.ordinal_position LIMIT ${INTERNAL_LIMIT}`,
    relationships: (schema) =>
      `SELECT tc.table_schema AS from_schema, tc.table_name AS from_table, kcu.column_name AS from_column,
              ccu.table_schema AS to_schema, ccu.table_name AS to_table, ccu.column_name AS to_column, tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND ((tc.table_name = $1 ${schema ? "AND tc.table_schema = $2" : ""}) OR (ccu.table_name = $1 ${schema ? "AND ccu.table_schema = $2" : ""}))`,
    enums: `SELECT t.typname AS enum_name, e.enumlabel AS value
            FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname NOT IN ('pg_catalog','information_schema')
            ORDER BY t.typname, e.enumsortorder LIMIT 1000`,
    functions: (prefix) =>
      `SELECT p.proname AS name, n.nspname AS schema_name, pg_get_function_arguments(p.oid) AS arguments
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')${prefix ? " AND p.proname LIKE $1" : ""}
       ORDER BY n.nspname, p.proname LIMIT 500`,
    approxRowCountHint: "Use `reltuples` from pg_class for approximate counts",
  },
  mysql: {
    tables: (schema) =>
      schema
        ? `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT 500`
        : `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND ${MYSQL_SCOPE} ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT 500`,
    tablesParams: (schema) => (schema ? [schema] : []),
    table: (schema) =>
      schema
        ? `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ? ORDER BY ORDINAL_POSITION`
        : `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_NAME = ? AND ${MYSQL_SCOPE} ORDER BY TABLE_SCHEMA, ORDINAL_POSITION`,
    search: (schema, keywordLike) =>
      `SELECT t.TABLE_SCHEMA, t.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE
       FROM information_schema.TABLES t
       JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
       WHERE t.TABLE_TYPE = 'BASE TABLE'
         ${schema ? "AND t.TABLE_SCHEMA = ?" : `AND ${MYSQL_SCOPE.replace(/TABLE_SCHEMA/g, "t.TABLE_SCHEMA")}`}
         AND (${keywordLike})
       ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION LIMIT ${INTERNAL_LIMIT}`,
    relationships: (schema) =>
      `SELECT kcu.TABLE_SCHEMA AS from_schema, kcu.TABLE_NAME AS from_table, kcu.COLUMN_NAME AS from_column,
              kcu.REFERENCED_TABLE_SCHEMA AS to_schema, kcu.REFERENCED_TABLE_NAME AS to_table, kcu.REFERENCED_COLUMN_NAME AS to_column, kcu.CONSTRAINT_NAME AS constraint_name
       FROM information_schema.KEY_COLUMN_USAGE kcu
       WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ${schema ? "" : "AND (DATABASE() IS NULL OR kcu.TABLE_SCHEMA = DATABASE())"}
         AND ((kcu.TABLE_NAME = ? ${schema ? "AND kcu.TABLE_SCHEMA = ?" : ""}) OR (kcu.REFERENCED_TABLE_NAME = ? ${schema ? "AND kcu.REFERENCED_TABLE_SCHEMA = ?" : ""}))`,
    approxRowCountHint: "Use `TABLE_ROWS` from `information_schema.TABLES` for approximate counts",
  },
  sqlite: {
    tables: () => `SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 500`,
    table: () => null, // uses PRAGMA
    search: null,
    relationships: null,
    approxRowCountHint: "SQLite does not track approximate row counts",
  },
  duckdb: {
    tables: (schema) =>
      `SELECT schema_name, table_name FROM duckdb_tables() WHERE NOT internal${schema ? ` AND schema_name = '${schema.replace(/'/g, "''")}'` : ""} ORDER BY schema_name, table_name LIMIT 500`,
    table: () => null, // duckdb_columns()
    approxRowCountHint: "Use `estimated_size` from duckdb_tables() for approximate counts",
  },
};

const keywordList = (name) => (Array.isArray(name) ? name : [name]).filter((k) => k != null && k !== "");

// ---------- lint ----------

function lintSql(sql) {
  const issues = [];
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  let depth = 0;
  for (const ch of stripped) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth < 0) {
      issues.push("unbalanced closing parenthesis");
      break;
    }
  }
  if (depth > 0) issues.push(`${depth} unclosed opening ${depth === 1 ? "parenthesis" : "parentheses"}`);
  if (/--\s*$/.test(stripped.trim())) issues.push("trailing line comment may swallow the remainder of a line");
  if (!/;\s*$/.test(sql.trim()) && /\n\s*$/m.test(sql)) issues.push("missing trailing semicolon (advisory)");
  return issues.length ? issues.join("\n") : undefined;
}

// ---------- main ----------

export async function runSql(args) {
  if (loadSettings().enabled === false) return mcpError("tokenSaver is disabled in settings.", "TOKENSAVER_DISABLED");
  const action = args.action ?? "query";
  const maxRows = args.max_rows ?? DEFAULT_MAX_ROWS;
  const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) return mcpError("timeout_ms must be an integer between 1 and 2147483647.", "SQL_BAD_ARGS");
  const opts = {
    format: args.format,
    maxColWidth: args.max_col_width ?? DEFAULT_MAX_COL_WIDTH,
    maxLineLength: args.max_line_length ?? DEFAULT_MAX_LINE_LENGTH,
  };

  let conn;
  try {
    conn = await currentConnection(args);
  } catch (e) {
    return mcpError(`Error: ${e.message}`, "SQL_CONNECT_FAILED");
  }
  const { dialect, driver } = conn;

  if (action === "connect") {
    try {
      await driver.execute("SELECT 1", [], timeoutMs);
      return mcpText(`connected: ${dialect}`);
    } catch (e) {
      if (isConnError(e)) {
        if (connections.get(conn.cacheKey) === conn) connections.delete(conn.cacheKey);
        if (lastConnection === conn) lastConnection = undefined;
        try { await driver.close(); } catch {}
      }
      return mcpError(`Error: connection failed — ${e.message}`, "SQL_CONNECT_FAILED");
    }
  }

  const run = async (sql, params, rowCap = maxRows) => {
    let res;
    try {
      res = await driver.execute(sql, params, timeoutMs);
    } catch (e) {
      if (isConnError(e)) {
        if (connections.get(conn.cacheKey) === conn) connections.delete(conn.cacheKey);
        if (lastConnection === conn) lastConnection = undefined;
        try { await driver.close(); } catch {}
      }
      throw e;
    }
    const truncated = res.rows.length > rowCap;
    return {
      columns: res.columns,
      rows: res.rows.slice(0, rowCap),
      rowCount: truncated ? res.rows.length : res.rowCount,
      truncated,
      rowCountExact: true,
    };
  };

  const exec = async (sql, params = [], cap = maxRows) => {
    const res = await run(sql, params, cap);
    return formatResult(res, opts);
  };

  try {
    switch (action) {
      case "query": {
        const sql = args.sql ?? args.query;
        if (!sql) return mcpError("Error: `sql` is required for action=query.", "SQL_BAD_ARGS");
        const notes = [];
        let finalSql = sql;
        if (args.auto_limit !== false) {
          const lim = applyAutoLimit(sql, maxRows);
          finalSql = lim.sql;
          if (lim.note) notes.push(lim.note);
        }
        let result;
        try {
          result = await run(finalSql, undefined);
        } catch (e) {
          // Auto-fixer retry (postgres): rewrite known dialect pitfalls once.
          if (dialect === "postgres" && !isConnError(e) && e.code !== "57014") {
            const fixed = applyFixers(finalSql, e);
            if (fixed) {
              notes.push(`auto-fixed common SQL pitfalls: ${fixed.description}`);
              result = await run(fixed.sql, undefined);
            } else {
              throw e;
            }
          } else {
            throw e;
          }
        }
        return mcpText([formatResult(result, opts), ...notes].join("\n"));
      }
      case "queries": {
        if (!Array.isArray(args.queries) || args.queries.length === 0) {
          return mcpError("Error: `queries` must be a non-empty array of {name, sql}.", "SQL_BAD_ARGS");
        }
        const sections = [];
        let failed = false;
        for (const q of args.queries) {
          let body;
          try {
            let sql = q.sql ?? "";
            if (args.auto_limit !== false) sql = applyAutoLimit(sql, maxRows).sql;
            body = await exec(sql);
          } catch (e) {
            failed = true;
            body = `ERROR: ${e.message}`;
          }
          sections.push(`--- ${q.name ?? "query"} ---\n${body}`);
        }
        return failed ? mcpError(sections.join("\n"), "SQL_QUERY_FAILED") : mcpText(sections.join("\n"));
      }
      case "tables": {
        const q = INTROSPECT[dialect].tables(args.schema);
        return mcpText(await exec(q, INTROSPECT[dialect].tablesParams?.(args.schema) ?? [], 500));
      }
      case "table": {
        if (!args.name) return mcpError("Error: `name` is required for action=table.", "SQL_BAD_ARGS");
        if (dialect === "sqlite") {
          const cols = await run(`PRAGMA table_info("${String(args.name).replace(/"/g, '""')}")`, [], 2000);
          return mcpText(formatResult({ columns: ["name", "type", "notnull", "dflt_value", "pk"], rows: cols.rows.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk })), rowCount: cols.rows.length, truncated: false, rowCountExact: true }, opts));
        }
        if (dialect === "duckdb") {
          return mcpText(await exec(
            `SELECT column_name, data_type, is_nullable FROM duckdb_columns() WHERE NOT internal AND table_name = '${args.name.replace(/'/g, "''")}' ORDER BY column_index`,
          ));
        }
        const params = args.schema ? [args.name, args.schema] : [args.name];
        return mcpText(await exec(INTROSPECT[dialect].table(args.schema), params, 2000));
      }
      case "search": {
        const keywords = keywordList(args.name);
        if (keywords.length === 0) return mcpError("Error: `name` (string or array) is required for action=search.", "SQL_BAD_ARGS");
        if (dialect === "sqlite") {
          const pat = keywords.map(() => "name LIKE ?").join(" OR ");
          return mcpText(await exec(`SELECT name AS table_name, sql FROM sqlite_master WHERE (${pat}) ORDER BY name LIMIT ${INTERNAL_LIMIT}`, keywords.map((k) => `%${k}%`)));
        }
        if (dialect === "duckdb") {
          // The CLI has no parameter-binding API; quote these generated
          // string literals rather than passing ignored placeholder values.
          const pat = keywords.map((k) => {
            const literal = "'%" + String(k).replace(/'/g, "''") + "%'";
            return `(table_name ILIKE ${literal} OR column_name ILIKE ${literal})`;
          }).join(" OR ");
          return mcpText(await exec(
            `SELECT schema_name, table_name, column_name, data_type, is_nullable FROM duckdb_columns()
             WHERE NOT internal AND (${pat})
             ORDER BY schema_name, table_name, column_name LIMIT ${INTERNAL_LIMIT}`,
            [],
          ));
        }
        if (dialect === "postgres") {
          const params = [keywords.map((k) => `%${k}%`)];
          if (args.schema) params.push(args.schema);
          return mcpText(await exec(INTROSPECT.postgres.search(args.schema), params, INTERNAL_LIMIT));
        }
        // mysql
        const pat = keywords.map(() => "(t.TABLE_NAME LIKE ? OR c.COLUMN_NAME LIKE ?)").join(" OR ");
        const params = args.schema ? [args.schema] : [];
        return mcpText(await exec(INTROSPECT.mysql.search(args.schema, pat), [...params, ...keywords.flatMap((k) => [`%${k}%`, `%${k}%`])], INTERNAL_LIMIT));
      }
      case "relationships": {
        if (!args.name) return mcpError("Error: `name` is required for action=relationships.", "SQL_BAD_ARGS");
        if (dialect === "sqlite") {
          const res = await run(`PRAGMA foreign_key_list("${String(args.name).replace(/"/g, '""')}")`, [], 2000);
          const rows = res.rows.map((r) => ({ from_table: args.name, from_column: r.from, to_table: r.table, to_column: r.to }));
          return mcpText(formatResult({ columns: ["from_table", "from_column", "to_table", "to_column"], rows, rowCount: rows.length, truncated: false, rowCountExact: true }, opts));
        }
        if (dialect === "duckdb") {
          return mcpText("relationships introspection is not supported for DuckDB — foreign keys are rarely declared.");
        }
        const pair = args.schema ? [args.name, args.schema] : [args.name];
        const params = dialect === "postgres" ? pair : [...pair, ...pair];
        return mcpText(await exec(INTROSPECT[dialect].relationships(args.schema), params, 500));
      }
      case "enums":
      case "types": {
        if (dialect !== "postgres") return mcpText(`action=${action} is only supported for PostgreSQL.`);
        return mcpText(await exec(INTROSPECT.postgres.enums, [], 1000));
      }
      case "functions":
      case "function": {
        if (dialect !== "postgres") return mcpText(`action=${action} is only supported for PostgreSQL.`);
        const params = args.prefix ? [args.prefix + "%"] : [];
        return mcpText(await exec(INTROSPECT.postgres.functions(args.prefix), params, 500));
      }
      case "lint": {
        const sql = args.sql ?? args.query;
        if (!sql) return mcpError("Error: `sql` is required for action=lint.", "SQL_BAD_ARGS");
        const issues = lintSql(sql);
        return mcpText(issues ? `lint issues:\n${issues}` : "lint: OK");
      }
      default:
        return mcpError(`Error: unknown action "${action}".`, "SQL_BAD_ARGS");
    }
  } catch (e) {
    const hint = recoveryHint(e, dialect);
    return mcpError(`Error: ${e.message}${hint ? `\n${hint}` : ""}`, e.code === "SQL_TIMEOUT" || e.code === "57014" ? "SQL_TIMEOUT" : "SQL_QUERY_FAILED");
  }
}

function applyFixers(sql, error) {
  for (const fixer of pgFixers) {
    try {
      const out = fixer.apply(sql);
      if (out != null && out !== sql) return { sql: out, description: fixer.description };
    } catch {}
  }
  return undefined;
}

const PG_CANCELLED = new Set(["57014", "57P01"]);
const CONN_ERRORS = new Set(["08000", "08003", "08006", "08001", "08004", "28000", "28P01", "CONNECT_TIMEOUT", "CONNECTION_DESTROYED", "CONNECTION_CLOSED", "CONNECTION_ENDED", "ECONNREFUSED", "ENOTFOUND"]);

function recoveryHint(e, dialect) {
  const code = e?.code;
  if (code && PG_CANCELLED.has(code)) {
    return "The query was cancelled by the statement timeout — narrow it with WHERE/LIMIT or raise timeout_ms.";
  }
  if (code && CONN_ERRORS.has(code)) {
    return "Connection problem — check that the database is reachable and the connection_string credentials are valid.";
  }
  if (/timeout/i.test(e?.message ?? "")) {
    return "Timed out — add a LIMIT, tighten the WHERE clause, or raise timeout_ms.";
  }
  return undefined;
}

export const sqlSchema = {
  name: "Sql",
  description:
    "Database introspection and bounded query execution across PostgreSQL, MySQL/MariaDB, SQLite and DuckDB.",
  inputSchema: {
    type: "object",
    properties: {
      cwd: { type: "string" },
      action: { type: "string", enum: ["tables", "table", "functions", "function", "enums", "types", "relationships", "search", "lint", "query", "queries", "connect"] },
      name: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      prefix: { type: "string" },
      sql: { type: "string" },
      queries: { type: "array", items: { type: "object" } },
      schema: { type: "string" },
      connection_string: { type: "string" },
      dialect: { type: "string", enum: ["postgres", "mysql", "sqlite", "duckdb"] },
      max_rows: { type: "integer" },
      timeout_ms: { type: "integer", minimum: 1, maximum: 2147483647 },
      auto_limit: { type: "boolean" },
      format: { type: "string", enum: ["csv", "json-csv", "table"] },
      max_col_width: { type: "integer" },
      max_line_length: { type: "integer" },
    },
  },
};
