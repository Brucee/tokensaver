// tokenSaver configuration: data dir, settings, per-project feature flags.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmdirSync } from "node:fs";
import { getHost } from "../host/index.mjs";

const HOME_ENV = "TOKENSAVER_HOME";
const FEATURE_ENV_PREFIX = "TOKENSAVER_FEATURE_";
const PROJECT_FLAGS_FILE = ".tokensaver.json";

const DEFAULT_FLAGS = {
  systemPromptReorder: true,
  protectedFiles: true,
  betterErrors: true,
  syntaxValidation: true,
  toolRedirect: true,
};

const DEFAULT_SETTINGS = {
  enabled: true,
  attribution: false,
  statusLine: true,
  statusLineSession: true,
  statusLineLifetime: true,
  statusLineTips: true,
  spinnerVerbs: true,
  defaultAgent: true,
  postCompactionDigest: true,
  autoSessionTitle: true,
  syntaxValidation: true,
  updateCheck: true,
};

export function tokensaverHome() {
  const fromEnv = process.env[HOME_ENV];
  if (fromEnv) return resolve(fromEnv);
  // Plugin state lives inside the host's config home: if that host goes away,
  // our state goes with it instead of orphaning a top-level dotdir.
  const host = getHost();
  const dir = host.homeDir();
  const legacy = host.legacyHome?.();
  // One-time migration: versions <1.0.5 kept state in the legacy dir.
  try {
    if (legacy && existsSync(legacy)) {
      if (!existsSync(dir)) {
        mkdirSync(resolve(dir, ".."), { recursive: true });
        renameSync(legacy, dir); // same volume → atomic move
      } else {
        // An older installed version may recreate the legacy dir while the new
        // one is already in use — fold in only entries the new dir lacks.
        for (const name of readdirSync(legacy)) {
          try {
            renameSync(join(legacy, name), join(dir, name));
          } catch {}
        }
        try {
          rmdirSync(legacy);
        } catch {}
      }
    }
  } catch {}
  return dir;
}

export function ensureHome() {
  const dir = tokensaverHome();
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
}

function readJsonSafe(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function loadSettings() {
  const file = join(tokensaverHome(), "settings.json");
  const settings = { ...DEFAULT_SETTINGS, ...readJsonSafe(file) };
  // Tool loading is controlled by the plugin manifest, not runtime settings.
  delete settings.alwaysLoadTools;
  return settings;
}

export function saveSettings(patch) {
  const file = join(tokensaverHome(), "settings.json");
  const next = { ...loadSettings(), ...patch };
  writeJsonAtomic(file, next);
  return next;
}

export function loadProjectFlags(cwd = process.cwd()) {
  const flags = { ...DEFAULT_FLAGS, syntaxValidation: loadSettings().syntaxValidation };
  const project = readJsonSafe(join(cwd, PROJECT_FLAGS_FILE));
  if (project) {
    for (const key of Object.keys(DEFAULT_FLAGS)) {
      if (typeof project[key] === "boolean") flags[key] = project[key];
    }
    // extra project fields (protectedPaths, protectFiles) pass through
    if (Array.isArray(project.protectedPaths)) flags.protectedPaths = project.protectedPaths;
    if (typeof project.protectFiles === "boolean") flags.protectFiles = project.protectFiles;
    if (typeof project.protectedFiles === "boolean") flags.protectFiles = project.protectedFiles; // documented key alias
  }
  for (const key of Object.keys(DEFAULT_FLAGS)) {
    const envVal = process.env[FEATURE_ENV_PREFIX + key.toUpperCase()];
    if (envVal != null) flags[key] = envVal === "1" || envVal === "true";
  }
  if (process.env[FEATURE_ENV_PREFIX + "PROTECTEDFILES"] != null) flags.protectFiles = flags.protectedFiles;
  return flags;
}

export function featureEnabled(name, cwd) {
  return loadProjectFlags(cwd)[name] === true;
}
