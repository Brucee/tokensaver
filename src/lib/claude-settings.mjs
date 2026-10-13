// Registration of the tokenSaver status-line command inside Claude Code's
// own settings file (~/.claude/settings.json or $CLAUDE_CONFIG_DIR/settings.json).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { loadSettings, saveSettings } from "./config.mjs";

export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function settingsPath() {
  return join(claudeConfigDir(), "settings.json");
}

// {} when the file is missing, null when it exists but won't parse — callers
// must not write back over a corrupt settings.json or they'd clobber the
// user's permissions/hooks/env with only our keys.
function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return e?.code === "ENOENT" ? {} : null;
  }
}

function writeSettings(value) {
  const file = settingsPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

export function statusLineCommand(pluginRoot) {
  const script = join(pluginRoot, "scripts", "status-line.cjs");
  return `node --no-warnings=ExperimentalWarning "${script}"`;
}

// A statusLine belongs to us when its command references our script name
// (or a leftover savings status-line from earlier installs).
function isOurs(entry) {
  const cmd = entry?.command;
  if (typeof cmd !== "string") return false;
  return cmd.includes("status-line.cjs") || cmd.includes("savings-status-line");
}

export function registerStatusLine(pluginRoot) {
  const settings = readSettings();
  if (settings == null) return;
  const command = statusLineCommand(pluginRoot);
  if (settings.statusLine?.command === command) return;
  // Back up a foreign statusLine so unregister can restore it instead of
  // silently destroying the user's own customization.
  if (settings.statusLine != null && !isOurs(settings.statusLine)) {
    saveSettings({ previousStatusLine: settings.statusLine });
  }
  settings.statusLine = { type: "command", command, padding: 0 };
  writeSettings(settings);
}

export function unregisterStatusLine() {
  const settings = readSettings();
  if (settings == null) return;
  if (!isOurs(settings.statusLine)) return;
  const previous = loadSettings().previousStatusLine;
  if (previous != null) {
    settings.statusLine = previous;
    saveSettings({ previousStatusLine: null });
  } else {
    delete settings.statusLine;
  }
  writeSettings(settings);
}

// ---------- default agent ----------

export const DEFAULT_AGENT = "tokensaver:code";

function agentIsOursOrDead(value) {
  return typeof value === "string" && value.startsWith("tokensaver:");
}

export function registerDefaultAgent() {
  const settings = readSettings();
  if (settings == null) return;
  if (settings.agent === DEFAULT_AGENT) return;
  if (settings.agent != null && !agentIsOursOrDead(settings.agent)) {
    saveSettings({ previousAgent: settings.agent });
  }
  settings.agent = DEFAULT_AGENT;
  writeSettings(settings);
}

export function unregisterDefaultAgent() {
  const settings = readSettings();
  if (settings == null) return;
  if (!agentIsOursOrDead(settings.agent)) return;
  const previous = loadSettings().previousAgent;
  if (previous != null && !agentIsOursOrDead(previous)) {
    settings.agent = previous;
    saveSettings({ previousAgent: null });
  } else {
    delete settings.agent;
  }
  writeSettings(settings);
}

// ---------- spinner verbs ----------

export const SPINNER_VERBS = [
  "Token-saving", "Deduping calls", "Fusing edits", "Batching edits",
  "Eliding context", "Compressing turns", "Trimming tokens", "Saving roundtrips",
  "Sharpening searches", "Inlining results", "Counting savings", "Pruning tool calls",
  "Slimming prompts", "Pinching pennies", "Frugalizing", "Economizing",
  "Merging round-trips", "Golfing tokens", "Lean-loading files", "Packing context",
  "Meter watching", "Clipping costs", "Savings accruing", "Thrift-maxxing",
  "Cost cutting", "Streamlining calls", "Defragging context", "Roundtrip removal",
];

const SPINNER_MARK = SPINNER_VERBS[0];

function spinnerIsOursOrDead(entry) {
  const verbs = entry?.verbs;
  if (!Array.isArray(verbs)) return false;
  return verbs.includes(SPINNER_MARK);
}

export function registerSpinnerVerbs() {
  const settings = readSettings();
  if (settings == null) return;
  if (spinnerIsOursOrDead(settings.spinnerVerbs)) {
    settings.spinnerVerbs = { mode: "replace", verbs: [...SPINNER_VERBS] };
    writeSettings(settings);
    return;
  }
  if (settings.spinnerVerbs != null) {
    saveSettings({ previousSpinnerVerbs: settings.spinnerVerbs });
  }
  settings.spinnerVerbs = { mode: "replace", verbs: [...SPINNER_VERBS] };
  writeSettings(settings);
}

export function unregisterSpinnerVerbs() {
  const settings = readSettings();
  if (settings == null) return;
  if (!spinnerIsOursOrDead(settings.spinnerVerbs)) return;
  const previous = loadSettings().previousSpinnerVerbs;
  if (previous != null) {
    settings.spinnerVerbs = previous;
    saveSettings({ previousSpinnerVerbs: null });
  } else {
    delete settings.spinnerVerbs;
  }
  writeSettings(settings);
}
