// Daemon state file: ~/.claude/tokensaver/router.json holds {pid, listenerPort,
// host, startedAt} so the CLI and session hook can check liveness and
// discover the bound (possibly ephemeral) port.
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tokensaverHome, ensureHome, writeJsonAtomic } from "../lib/config.mjs";

export function routerStatePath() {
  return join(tokensaverHome(), "router.json");
}

export function readRouterState() {
  try {
    const raw = JSON.parse(readFileSync(routerStatePath(), "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

export function writeRouterState(state) {
  ensureHome();
  writeJsonAtomic(routerStatePath(), state);
}

export function clearRouterState() {
  try {
    if (existsSync(routerStatePath())) unlinkSync(routerStatePath());
  } catch {}
}

// Pid liveness — signal 0 probes existence without delivering a signal.
export function pidAlive(pid) {
  if (typeof pid !== "number" || !(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

export async function healthCheck(host, port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function daemonStatus() {
  const info = readRouterState();
  if (info == null) return { alive: false, info: null };
  const pidOk = pidAlive(info.pid);
  const httpOk = pidOk && (await healthCheck(info.host ?? "127.0.0.1", info.listenerPort));
  return { alive: pidOk && httpOk, info };
}
