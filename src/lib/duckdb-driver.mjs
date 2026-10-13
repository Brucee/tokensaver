import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";

const execFileAsync = promisify(execFile);

export function duckdbDriver(databasePath, checkPolicy) {
  let timeoutMs = 30_000;
  let active;
  let finished;
  return {
    async setTimeoutMs(ms) { timeoutMs = ms; },
    query(sql) {
      finished = (async () => {
        checkPolicy(); // re-read even when the connection descriptor is cached
        if (/^\s*\./m.test(sql)) throw new Error("DuckDB CLI dot-commands are not permitted; use SQL statements only.");
        const parent = resolve(tmpdir());
        const privateDir = mkdtempSync(join(parent, "tokensaver-duckdb-"));
        const init = join(privateDir, "init.sql");
        try {
          // Replace ~/.duckdbrc, disable spill files and extension loading,
          // then irreversibly enter CLI safe mode before evaluating user SQL.
          // Unsupported settings/CLI versions fail closed via -bail.
          writeFileSync(init, [
            "SET temp_directory='';",
            "SET memory_limit='256MB';",
            "SET threads=2;",
            "SET autoinstall_known_extensions=false;",
            "SET autoload_known_extensions=false;",
            "SET allow_community_extensions=false;",
            "SET allowed_paths=[];",
            "SET allowed_directories=[];",
            ".safe_mode",
            "",
          ].join("\n"));
          const running = execFileAsync(process.env.TOKENSAVER_DUCKDB ?? "duckdb", [
            "-bail", "-batch", "-init", init, "-json", databasePath, "-c", sql,
          ], { cwd: privateDir, encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, killSignal: "SIGKILL" });
          active = running.child;
          const { stdout } = await running;
          const rows = stdout.trim() ? JSON.parse(stdout) : [];
          return { columns: rows[0] ? Object.keys(rows[0]) : [], rows, rowCount: rows.length };
        } catch (error) {
          if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("DuckDB output exceeded 8 MiB; narrow the query or use LIMIT.");
          if (error.killed) throw Object.assign(new Error(`DuckDB timeout after ${timeoutMs} ms; process terminated.`), { code: "SQL_TIMEOUT" });
          throw error;
        } finally {
          active = undefined;
          const rel = relative(parent, privateDir);
          if (rel && !isAbsolute(rel) && !rel.startsWith("..")) rmSync(privateDir, { recursive: true, force: true });
        }
      })();
      return finished;
    },
    abort() { active?.kill("SIGKILL"); },
    async close() { active?.kill("SIGKILL"); await finished?.catch(() => {}); },
  };
}
