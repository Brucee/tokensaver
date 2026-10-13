// Keep tests away from real Claude/tokenSaver settings and from parent Git
// repositories (which otherwise change the meaning of project-scope tests).
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempParent = resolve(tmpdir());
const sandbox = mkdtempSync(join(tempParent, "tokensaver-functional-"));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("TOKENSAVER_")) delete env[key];
for (const dir of ["tmp", "home", "claude"]) mkdirSync(join(sandbox, dir));
Object.assign(env, {
  TEMP: join(sandbox, "tmp"), TMP: join(sandbox, "tmp"), TMPDIR: join(sandbox, "tmp"),
  TOKENSAVER_HOME: join(sandbox, "home"), CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
  GIT_CEILING_DIRECTORIES: sandbox, GIT_CONFIG_GLOBAL: join(sandbox, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
});
const files = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs")).sort();
try {
  process.exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files.map((f) => join(root, "test", f))], {
      cwd: root, env, stdio: "inherit", windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
} finally {
  const rel = relative(tempParent, sandbox);
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) throw new Error("Unsafe test cleanup path");
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
