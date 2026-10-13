// settings-helper: --show | --set <key> <value>
// Writes to <tokensaver home>/settings.json; some keys have host side effects
// (statusLine registers/unregisters the command in the host settings file —
// Claude only; on Codex the boolean is saved but nothing else happens).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadSettings, saveSettings } from "../lib/config.mjs";
import { loadSqlPolicy } from "../lib/sql-policy.mjs";
import { registerStatusLine, unregisterStatusLine, registerDefaultAgent, unregisterDefaultAgent, registerSpinnerVerbs, unregisterSpinnerVerbs } from "../lib/claude-settings.mjs";
import { getHost } from "../host/index.mjs";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BOOL_KEYS = new Set([
  "enabled", "statusLine", "statusLineSession", "statusLineLifetime", "statusLineTips",
  "spinnerVerbs", "defaultAgent", "postCompactionDigest", "autoSessionTitle", "syntaxValidation",
]);
const INTERNAL_KEYS = new Set(["version"]);

const CLEAR_WORDS = new Set(["none", "off", "clear", "null"]);

function hostSettingsPath() {
  return getHost().hostSettingsFile();
}

// {} when missing, null when corrupt — never write back over a broken
// settings file or we'd destroy the user's permissions/hooks/env.
function readHostSettings() {
  try {
    return JSON.parse(readFileSync(hostSettingsPath(), "utf8"));
  } catch (e) {
    return e?.code === "ENOENT" ? {} : null;
  }
}

function writeHostSettings(value) {
  const file = hostSettingsPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

function setSqlPolicy(value) {
  const file = hostSettingsPath();
  if (CLEAR_WORDS.has(value.toLowerCase())) {
    const s = readHostSettings();
    if (s == null) { process.stderr.write(`Error: ${file} exists but is not valid JSON — fix it first.\n`); process.exit(1); }
    if (s.tokensaver) delete s.tokensaver.sql;
    writeHostSettings(s);
    process.stdout.write("Cleared the Sql connection policy — the Sql tool may connect to any database again.\n");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    process.stderr.write(`Error: value for "sql" must be a JSON policy object (or "none" to clear), got: ${value}\n`);
    process.exit(1);
  }
  const s = readHostSettings();
  if (s == null) { process.stderr.write(`Error: ${file} exists but is not valid JSON — fix it first.\n`); process.exit(1); }
  s.tokensaver = { ...(s.tokensaver ?? {}), sql: parsed };
  writeHostSettings(s);
  const loaded = loadSqlPolicy();
  if (loaded.status === "invalid") {
    process.stderr.write(`Warning: policy written but invalid — ${loaded.error}\n`);
  }
  process.stdout.write(`Set sql = ${JSON.stringify(parsed)}\nTakes effect on the next Sql tool call.\n`);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--show") {
    const shown = { ...loadSettings() };
    const policy = loadSqlPolicy();
    if (policy.status === "valid") shown.sql = policy.policy;
    process.stdout.write(JSON.stringify(shown, null, 2) + "\n");
    return;
  }
  if (args[0] === "--set" && args.length >= 3) {
    const key = args[1];
    const value = args[2];
    if (key === "alwaysLoadTools") {
      process.stderr.write("Error: alwaysLoadTools is controlled by .mcp.json; this runtime setting is unsupported.\n");
      process.exit(1);
    }
    if (INTERNAL_KEYS.has(key)) {
      process.stderr.write(`Error: "${key}" is an internal setting and isn't configurable via tokensaver.\n`);
      process.exit(1);
    }
    if (key === "sql") {
      setSqlPolicy(value);
      return;
    }
    if (!BOOL_KEYS.has(key)) {
      process.stderr.write(`Error: unknown setting "${key}". Valid settings: ${[...BOOL_KEYS, "sql"].join(", ")}\n`);
      process.exit(1);
    }
    if (value !== "true" && value !== "false") {
      process.stderr.write(`Error: value for "${key}" must be "true" or "false", got "${value}"\n`);
      process.exit(1);
    }
    const on = value === "true";
    try {
      saveSettings({ [key]: on });
    } catch (e) {
      process.stderr.write(`Error: failed to write settings — ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    const settings = loadSettings();
    // Host-settings side effects (statusline command, default agent, spinner
    // verbs) are Claude-only — on other hosts the boolean is saved and the
    // registration is skipped.
    if (getHost().capabilities.hostSettings) {
      if (key === "statusLine" || key === "enabled") {
        if (settings.enabled && settings.statusLine) registerStatusLine(PLUGIN_ROOT);
        else unregisterStatusLine();
      }
      if (key === "defaultAgent" || key === "enabled") {
        if (settings.enabled && settings.defaultAgent) registerDefaultAgent();
        else unregisterDefaultAgent();
      }
      if (key === "spinnerVerbs" || key === "enabled") {
        if (settings.enabled && settings.spinnerVerbs) registerSpinnerVerbs();
        else unregisterSpinnerVerbs();
      }
    }
    process.stdout.write(`Set ${key} = ${on}\n`);
    if (key === "syntaxValidation") {
      process.stdout.write("Takes effect immediately on the next edit.\n");
    }
    if (key === "postCompactionDigest") {
      process.stdout.write("Applies to compactions from here on, in this and new sessions.\n");
    }
    if (key === "autoSessionTitle") {
      process.stdout.write("Applies from the next prompt on, in this and new sessions.\n");
    }
    return;
  }
  process.stderr.write(
    "Usage:\n  --show              Show current settings\n  --set <key> <value> Update a setting (boolean: true/false; sql: JSON policy or \"none\")\n"
  );
  process.exit(1);
}

try {
  main();
} catch (e) {
  process.stderr.write(`[tokensaver:settings-helper] ${e?.stack ?? e}\n`);
  process.exit(1);
}
