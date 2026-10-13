import { fork } from "node:child_process";

const children = new Set();
process.once("exit", () => { for (const child of children) child.kill("SIGKILL"); });

// Native SQLite calls are synchronous. A separate OS process allows the
// caller to terminate CPU-bound queries as well as queries waiting for locks.
export async function openSqliteProcess(databasePath, timeoutMs) {
  const child = fork(new URL("./sqlite-worker.mjs", import.meta.url), [databasePath], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced", windowsHide: true,
    execArgv: [],
  });
  children.add(child);
  let closed = false;
  let pending;
  let sequence = 0;
  let busyTimeout = timeoutMs;
  let stderr = "";
  child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-2000); });
  const exited = new Promise((done) => {
    const finish = (error) => {
      closed = true;
      children.delete(child);
      pending?.reject(error instanceof Error ? error : Object.assign(new Error(stderr || "SQLite connection ended"), { code: "CONNECTION_ENDED" }));
      pending = undefined;
      done();
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
  child.on("message", (message) => {
    if (!pending || message.id !== pending.id) return;
    const current = pending;
    pending = undefined;
    child.unref(); child.channel?.unref(); child.stderr.unref?.();
    if (message.error) current.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else current.resolve(message.result);
  });
  const send = (payload) => new Promise((resolve, reject) => {
    if (closed) return reject(Object.assign(new Error("SQLite connection ended"), { code: "CONNECTION_ENDED" }));
    child.ref(); child.channel?.ref(); child.stderr.ref?.();
    const id = ++sequence;
    pending = { id, resolve, reject };
    child.send({ id, ...payload }, (error) => { if (error && pending?.id === id) { pending = undefined; reject(error); } });
  });
  const abort = () => { closed = true; child.ref(); child.kill("SIGKILL"); };
  let timer;
  try {
    await Promise.race([
      send({ action: "open" }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        abort(); reject(Object.assign(new Error("SQLite connection timeout"), { code: "SQL_TIMEOUT" }));
      }, timeoutMs); }),
    ]);
  } catch (error) { abort(); await exited; throw error; }
  finally { clearTimeout(timer); }
  return {
    setTimeoutMs: async (ms) => { busyTimeout = ms; },
    query: (sql, params = []) => send({ action: "query", sql, params, timeoutMs: busyTimeout }),
    abort,
    async close() { abort(); await exited; },
  };
}
