// `tokensaver router` — manage the loopback router daemon and the
// ANTHROPIC_BASE_URL activation in ~/.claude/settings.json.
//
// activate [preset]  — start the daemon (if needed) and point Claude Code at
//                      http://127.0.0.1:<port>/router-preset/<preset>
// deactivate         — restore the previous base URL (or remove ours)
// status             — show daemon liveness + active routing
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, saveSettings } from "../lib/config.mjs";
import { claudeConfigDir } from "../lib/claude-settings.mjs";
import { readRouterState, daemonStatus, healthCheck } from "../router/state.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_ENTRY = join(PLUGIN_ROOT, "servers", "router-daemon.mjs");
const ROUTER_URL_RE = /\/router-preset(\/[^\s"']*)?/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function claudeSettingsPath() {
  return join(claudeConfigDir(), "settings.json");
}

// {} when missing, null when corrupt — never write back over a broken
// settings.json or we'd destroy the user's permissions/hooks/env.
function readClaudeSettings() {
  try {
    return JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
  } catch (e) {
    return e?.code === "ENOENT" ? {} : null;
  }
}

function writeClaudeSettings(value) {
  const file = claudeSettingsPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

export function isLoopbackUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function presetBaseUrl(info, presetPath) {
  const host = info.host === "0.0.0.0" || info.host === "::" ? "127.0.0.1" : info.host ?? "127.0.0.1";
  return `http://${host}:${info.listenerPort}/router-preset${presetPath}`;
}

async function ensureDaemonRunning() {
  const status = await daemonStatus();
  if (status.alive) return { info: status.info, wasRunning: true };
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const info = readRouterState();
    if (info?.listenerPort != null && (await healthCheck(info.host ?? "127.0.0.1", info.listenerPort))) {
      return { info, wasRunning: false };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("router daemon did not bind a listener within 10s");
}

// ---------- activate / deactivate ----------

export async function routerActivate(presetPath = "/claudecode") {
  const settings = readClaudeSettings();
  if (settings == null) return { ok: false, error: "Refusing to activate: ~/.claude/settings.json exists but is not valid JSON — fix it first." };
  const current = settings.env?.ANTHROPIC_BASE_URL;
  if (typeof current === "string" && !isLoopbackUrl(current) && !ROUTER_URL_RE.test(current)) {
    // Never silently clobber a non-loopback override — credentials would leak.
    return {
      ok: false,
      error:
        `Refusing to activate: ANTHROPIC_BASE_URL already points at a non-loopback host (${current}).\n` +
        "This router replays your Anthropic credentials upstream. Clear or fix that value first.",
    };
  }

  const { info, wasRunning } = await ensureDaemonRunning();
  const url = presetBaseUrl(info, presetPath);

  // Back up a foreign value once, so deactivate restores the user's setup.
  const prevBackup = loadSettings().previousRouterBaseUrl;
  if (current != null && !ROUTER_URL_RE.test(current) && prevBackup == null) {
    saveSettings({ previousRouterBaseUrl: current });
  }
  settings.env ??= {};
  settings.env.ANTHROPIC_BASE_URL = url;
  writeClaudeSettings(settings);
  return { ok: true, url, port: info.listenerPort, preset: presetPath, alreadyRunning: wasRunning };
}

export function routerDeactivate() {
  const settings = readClaudeSettings();
  if (settings == null) return { ok: false, changed: false, error: "settings.json is not valid JSON — fix it manually." };
  const current = settings.env?.ANTHROPIC_BASE_URL;
  if (typeof current !== "string" || !ROUTER_URL_RE.test(current)) {
    return { ok: true, changed: false };
  }
  const previous = loadSettings().previousRouterBaseUrl;
  if (previous != null && !ROUTER_URL_RE.test(previous)) {
    settings.env.ANTHROPIC_BASE_URL = previous;
    saveSettings({ previousRouterBaseUrl: null });
  } else {
    delete settings.env.ANTHROPIC_BASE_URL;
    if (Object.keys(settings.env).length === 0) delete settings.env;
  }
  writeClaudeSettings(settings);
  return { ok: true, changed: true };
}

export async function routerStatus() {
  const status = await daemonStatus();
  const settings = readClaudeSettings();
  const active = settings?.env?.ANTHROPIC_BASE_URL ?? null;
  return {
    daemon: status.alive ? "running" : "stopped",
    pid: status.info?.pid ?? null,
    port: status.info?.listenerPort ?? null,
    startedAt: status.info?.startedAt ?? null,
    anthropicBaseUrl: active,
    routed: typeof active === "string" && ROUTER_URL_RE.test(active),
  };
}

// Ensure the daemon is up when a session starts while routing is active.
// Called by the session hook; cheap no-op when not routed or already alive.
export async function ensureRouterIfActive() {
  const settings = readClaudeSettings();
  if (settings == null) return { routed: false };
  const active = settings.env?.ANTHROPIC_BASE_URL;
  if (typeof active !== "string" || !ROUTER_URL_RE.test(active)) return { routed: false };
  const status = await daemonStatus();
  if (status.alive) return { routed: true, restarted: false, port: status.info.listenerPort };
  const { info } = await ensureDaemonRunning();
  // The daemon binds an ephemeral port — after a respawn the stored URL points
  // at a dead port. Rewrite it keeping the preset path, or every session stays broken.
  if (info.listenerPort != null) {
    try {
      const u = new URL(active);
      if (u.port !== String(info.listenerPort)) {
        u.port = String(info.listenerPort);
        settings.env.ANTHROPIC_BASE_URL = u.toString();
        writeClaudeSettings(settings);
      }
    } catch {}
  }
  return { routed: true, restarted: true, port: info.listenerPort };
}
