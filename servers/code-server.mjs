#!/usr/bin/env node
// tokenSaver MCP server — stdio transport.
// Registers the three tools: Search, Edit, Sql.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runSearch } from "../src/tools/search.mjs";
import { runEdit } from "../src/tools/edit.mjs";
import { runSql } from "../src/tools/sql.mjs";

const server = new McpServer({
  name: "tokensaver-code",
  version: process.env.TOKENSAVER_BUNDLE_VERSION ?? "1.0.7",
});

const notImplemented = (name) => async () => ({
  isError: true,
  content: [{ type: "text", text: `[tokenSaver] ${name}: not implemented yet` }],
});

// --- Schemas (per MCP SDK zod shape) ---------------------------------------
// Full behavioral spec lives in PLAN-TOKENSAVER.md / IMPLEMENTATION.md;
// schemas are filled in Steps 2–4.

server.registerTool(
  "Search",
  {
    title: "Search",
    description:
      "A fused file discovery, grep, file reading and image viewing tool — prefer it over the built-in Grep/Glob/Read tools and over shell find/grep/cat/head/tail.\n\n" +
      "Strategy: pack work into one call. A single call carrying every path/glob you might need beats a sequence of narrow calls — tool-side filtering is far cheaper than another round-trip. \"Narrow\" means tightening the pattern, not the call count.\n" +
      "- Default to output_mode \"file_paths_with_content\" whenever contents might be needed — it discovers and reads in one step.\n" +
      "- Combine file_glob_patterns with content_regex or type in the same call to narrow by scope and content at once.\n" +
      "- Pass every path/glob you already know up front and let the tool filter.\n" +
      "- Run independent searches in parallel within one response; do not chain them serially.\n" +
      "- Reuse if_modified_since for content already received; omit it for a new query or previously truncated sections.\n" +
      "Each parameter's doc carries the details; this description is the strategy.",
    inputSchema: {
      file_glob_patterns: z
        .array(z.string())
        .optional()
        .describe(
          "Array of exact file paths and/or glob patterns, relative to cwd (or absolute). Example: [\"src/**/*.ts\", \"package.json\"]. Literal paths accept #N and #N-M line-range suffixes.",
        ),
      content_regex: z
        .string()
        .optional()
        .describe(
          "JS/TS regular expression matched against file contents. Strong preference: when you know both the file scope and the text pattern, pass both in the same call.",
        ),
      output_mode: z
        .enum(["file_paths_only", "file_paths_with_match_count", "file_paths_with_content"])
        .optional()
        .describe(
          "Result shape. Prefer \"file_paths_with_content\" whenever file contents may be needed — it avoids an extra round-trip. Default: file_paths_with_content.",
        ),
      lines_before: z.number().int().nonnegative().optional().describe("Lines of context before each match (content mode)."),
      lines_after: z.number().int().nonnegative().optional().describe("Lines of context after each match (content mode)."),
      ignore_case: z.boolean().optional().describe("Case-insensitive matching."),
      include_ignored: z.boolean().optional().describe("Include paths excluded by project .gitignore files. Literal file paths always bypass ignore rules. Default false."),
      type: z
        .string()
        .optional()
        .describe('File type filter, e.g. "ts", "js", "sql", "txt". Prefer it when the target type is known; combines with content_regex in one call.'),
      file_limit: z
        .number()
        .optional()
        .describe("Process at most N matching files. Use it to keep a combined search-and-read call small enough instead of splitting into separate calls."),
      lines_per_file: z
        .number()
        .optional()
        .describe("Max matching lines shown per file (content mode). Omitted = 500. 0 = no per-file cap. Total response stays bounded."),
      if_modified_since: z
        .string()
        .optional()
        .describe(
          'Timestamp from a previous result\'s <search_result if_modified_since="…" /> tag. Files modified at or before it return as metadata only — pass it on follow-up searches to avoid re-billing unchanged files.',
        ),
      max_line_length: z.number().optional().describe("Max characters per line. Omitted = 1000. 0 = unlimited. Longer lines are truncated with an omission marker."),
      multiline: z.boolean().optional().describe("Multiline mode: `.` matches newlines and patterns may span lines. Default false."),
      cwd: z.string().optional().describe("Absolute path used as the base for relative path arguments. Set it whenever a path argument is relative."),
      summary: z.boolean().optional().describe("Return signatures and structure, eliding bodies. Supports JS/TS, Python, Java, Rust, PHP, Go, C and C++. Default false."),
      list_importers: z.boolean().optional().describe("TS/JS only. Default false. True appends, after each TS/JS file, the list of modules importing it (`Imported by`)."),
    },
  },
  (args) => runSearch(args, { cwd: process.cwd() }),
);

server.registerTool(
  "Edit",
  {
    title: "Edit",
    description:
      "Create files or apply search/replace edits with fuzzy matching — prefer it over the built-in Edit/Write/NotebookEdit tools and over shell redirection (cat >, sed -i, echo >>). Omit `old_string` to create a new file.\n\n" +
      "Strategy: `edits` is the batching surface — put EVERY change for this task in this one array, across as many files as needed. One call with ten entries beats ten calls with one each in both latency and cost; prefer several small edit objects over a single edit carrying a huge new_string. When a task spans multiple files, identify them up front and batch the edits.\n" +
      "Prefer the smallest edit that satisfies the request: a targeted old_string/new_string that touches only the lines that need to change beats rewriting the whole file — output tokens scale with the text you emit.",
    inputSchema: {
      cwd: z.string().optional().describe("Absolute path used as the base for relative path arguments. Set it whenever a path argument is relative."),
      edits: z
        .array(
          z.object({
            file_path: z.string().describe("Target file path relative to cwd (or absolute). .ipynb paths accept #cell selectors (index, id, first, last)."),
            old_string: z.string().optional().describe("Text to replace. Omit (with overwrite) to create a new file. Supports elision wildcards: /* ... */, .../… and [⋯...] omit-tags."),
            new_string: z.string().describe("Replacement text; for file creation, the full file content."),
            overwrite: z.boolean().optional().describe("Allow replacing the whole file / creating it."),
            replace_all: z.boolean().optional().describe("Replace every occurrence of old_string instead of failing on ambiguous matches."),
            cell_action: z.enum(["insert_after", "insert_before", "delete", "move_after", "move_before"]).optional().describe("ipynb-only cell operation on the #cell-selected cell."),
            cell_move_target: z.union([z.string(), z.number().int().nonnegative()]).optional().describe("Destination cell (index or id) for move_* actions."),
            cell_type: z.string().optional().describe("ipynb cell type (e.g. code/markdown) when inserting."),
          }),
        )
        .describe("All edits for this task in one array — batch across files rather than splitting into separate calls."),
    },
  },
  (args) => runEdit(args, { cwd: process.cwd() }),
);

server.registerTool(
  "Sql",
  {
    title: "Sql",
    description:
      "Query database schema structure or run SQL against a live database (PostgreSQL, MySQL/MariaDB, SQLite, DuckDB) — use it instead of reading .sql schema dumps.\n\n" +
      "Use action='search' for schema keyword searches and 'relationships' for foreign keys. Pass connection_string with any action to auto-connect; 'connect' only checks connectivity. Batch statements with action='queries' and queries[]. Rows default to CSV; use 'json-csv' for columnar JSON or 'table' for a grid. If no connection string is available, ask the user for one; do not search for credentials.",
    inputSchema: {
      cwd: z.string().optional().describe("Absolute path used as the base for relative path arguments."),
      action: z
        .enum(["tables", "table", "functions", "function", "enums", "types", "relationships", "search", "lint", "query", "queries", "connect"])
        .describe("Action to perform."),
      name: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('Table/function/type name, or search keywords. For search pass an array to match several keywords at once (e.g. ["project", "message", "env_var"]).'),
      prefix: z.string().optional().describe("Prefix filter for functions/types actions."),
      sql: z.string().optional().describe("SQL text for the query or lint actions."),
      queries: z
        .array(z.object({ name: z.string().optional(), sql: z.string() }))
        .optional()
        .describe('Batch of named queries run sequentially in one call — use instead of N back-to-back query calls.'),
      schema: z.string().optional().describe("Schema name filter (default: all schemas)."),
      connection_string: z
        .string()
        .optional()
        .describe("Connection string; applies to any action and auto-connects for that call. Supported: postgresql://, mysql://, sqlite file paths, duckdb file paths."),
      dialect: z.enum(["postgres", "mysql", "sqlite", "duckdb"]).optional().describe("Optional dialect override when the connection_string scheme is ambiguous; normally auto-detected."),
      max_rows: z.number().optional().describe("Max rows returned (default 500). Lower for fast exploration, higher for exports."),
      timeout_ms: z.number().int().min(1).max(2147483647).optional().describe("Statement timeout in ms (default 30000). Expiry may discard the connection; check before retrying writes."),
      auto_limit: z.boolean().optional().describe("When true (default), appends LIMIT to unbounded SELECTs as a safety net. Pass false when you genuinely need every row."),
      format: z.enum(["csv", "json-csv", "table"]).optional().describe('Output format for query: "csv" (default, RFC-4180 + row-count footer), "json-csv" (columnar JSON), "table" (grid).'),
      max_col_width: z.number().optional().describe("Max characters per cell (default 60, 0 = unlimited)."),
      max_line_length: z.number().optional().describe("Max characters per output row (default 1000, 0 = unlimited)."),
    },
  },
  (args) => runSql(args),
);

await server.connect(new StdioServerTransport());
