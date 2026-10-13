// Update check: compares the installed plugin version against the latest
// version published on the GitHub repo. The SessionStart hook only READS a
// cache file — a detached child does the fetch, so session startup never
// blocks on the network. One outbound GET per TTL window, nothing sent.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokensaverHome } from "./config.mjs";

const CHECK_TTL_MS = 24 * 60 * 60 * 1000; // refresh at most once a day
const FETCH_TIMEOUT_MS = 4000;
const REPO = process.env.TOKENSAVER_REPO ?? "Brucee/tokensaver";
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/main/.claude-plugin/plugin.json`;

export function updateCheckPath() {
  return join(tokensaverHome(), "update-check.json");
}

export function localVersion(pluginRoot) {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

// Semver-ish compare: remote is strictly newer only if a numeric component
// is greater (1.0.4 > 1.0.3; equal or lower → false).
export function isNewerVersion(remote, local) {
  if (typeof remote !== "string" || typeof local !== "string") return false;
  const p = (v) => v.split(".").map((x) => parseInt(x, 10) || 0);
  const [a, b] = [p(remote), p(local)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

// Returns a tip string when the cache says a newer version exists, else
// undefined. When the cache is stale (or absent), spawns a detached refresh
// so the NEXT session sees fresh data — this call never does network I/O.
const UPDATE_COMMANDS = {
  claude: "claude plugin marketplace update tokensaver-marketplace && claude plugin update tokensaver@tokensaver-marketplace -y",
  codex: "codex plugin marketplace upgrade tokensaver-marketplace && codex plugin add tokensaver@tokensaver-marketplace",
};

export function updateAvailableTip(pluginRoot, { now = Date.now(), hostName = "claude" } = {}) {
  let cache;
  try {
    cache = JSON.parse(readFileSync(updateCheckPath(), "utf8"));
  } catch {}
  if (!cache?.checkedAt || now - cache.checkedAt > CHECK_TTL_MS) spawnRefresh();
  const local = localVersion(pluginRoot);
  if (!isNewerVersion(cache?.latestVersion, local)) return undefined;
  const cmd = UPDATE_COMMANDS[hostName] ?? UPDATE_COMMANDS.claude;
  return (
    `tokenSaver update available: v${cache.latestVersion} (installed v${local}). ` +
    `Tell the user they can update with the /tokensaver:update command, or \`${cmd}\` — a session restart is required afterwards.`
  );
}

function spawnRefresh() {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--refresh"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

// Fetch the published manifest and write the cache. Runs as the detached
// `--refresh` child; checkedAt is written even on failure so the TTL still
// rate-limits retries when GitHub is unreachable.
export async function refreshUpdateCheck({ url = MANIFEST_URL } = {}) {
  let latest = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.ok) latest = (await res.json())?.version ?? null;
  } catch {}
  const data = { checkedAt: Date.now(), latestVersion: latest };
  try {
    mkdirSync(tokensaverHome(), { recursive: true });
    writeFileSync(updateCheckPath(), JSON.stringify(data));
  } catch {}
  return data;
}

if (process.argv.includes("--refresh")) {
  refreshUpdateCheck().catch(() => {});
}
