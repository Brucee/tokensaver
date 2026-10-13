export function sqlDeadline(task, timeoutMs, abort = () => {}) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { abort(); } catch {}
      reject(Object.assign(new Error(`SQL timeout after ${timeoutMs} ms; connection discarded. Check the database before retrying a write.`), { code: "SQL_TIMEOUT" }));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(task), expired]).finally(() => clearTimeout(timer));
}

// SET timeout and the statement must belong to the same serialized request.
export function serializeDriver(driver) {
  let queue = Promise.resolve();
  let closed = false;
  return {
    async execute(sql, params, timeoutMs) {
      const result = queue.then(() => {
        if (closed) throw Object.assign(new Error("SQL connection ended; reconnect explicitly"), { code: "CONNECTION_ENDED" });
        return sqlDeadline(async () => {
          await driver.setTimeoutMs(timeoutMs);
          if (closed) throw Object.assign(new Error("SQL connection ended"), { code: "CONNECTION_ENDED" });
          return driver.query(sql, params);
        }, timeoutMs, () => { closed = true; driver.abort?.(); });
      });
      queue = result.catch(() => {});
      return result;
    },
    async close() { closed = true; await driver.close(); },
  };
}
