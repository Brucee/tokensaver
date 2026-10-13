// Hook I/O helpers: read the JSON envelope Claude Code pipes to stdin,
// write hook output JSON to stdout, and wrap entrypoints so they never throw.

const IDLE_TIMEOUT_MS = 60;     // stop waiting once data has arrived and gone quiet
const OVERALL_TIMEOUT_MS = 3000; // hard cap — must cover large envelopes, not just idle stdin

export function readStdinJson({
  idleAfterDataInMs = IDLE_TIMEOUT_MS,
  overallTimeoutInMs = OVERALL_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let buf = "";
    let idle;
    const overall = setTimeout(() => done(), overallTimeoutInMs);
    const done = () => {
      clearTimeout(idle);
      clearTimeout(overall);
      process.stdin.removeAllListeners();
      resolve(buf);
    };
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(done, idleAfterDataInMs);
    };
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      arm();
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    arm();
  });
}

export async function readHookInput(opts) {
  const raw = await readStdinJson(opts);
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writeHookOutput(value) {
  process.stdout.write(JSON.stringify(value));
}

export function additionalContext(text) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: text } };
}

// Wrap a hook/entrypoint main: catch everything, log to stderr, exit 0 so a
// broken hook can never block the host session.
export function safeMain(name, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      try {
        process.stderr.write(`[tokensaver:${name}] ${err?.stack ?? err}\n`);
      } catch {}
    })
    .finally(() => process.exit(0));
}
