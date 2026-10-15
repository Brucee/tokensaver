// Router configuration: loads the bundled router-config.jsonc defaults plus
// optional user overrides from ~/.claude/tokensaver/router-config.jsonc. Provider and
// preset entries are merged by id/path — user entries replace bundled ones.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { tokensaverHome } from "../lib/config.mjs";

const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const ROUTER_PRESET_PREFIX = "/router-preset";

// ---------- jsonc parsing ----------

// Strip // and /* */ comments and trailing commas; keep string contents intact.
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\") j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Trailing comma: drop it only when the next non-space char closes a
    // container — doing this inside the scanner keeps commas inside string
    // literals (e.g. "a,]") untouched, which a post-pass regex cannot.
    if (ch === ",") {
      let k = i + 1;
      // Look past whitespace and comments: `1, // note\n]` is still trailing.
      for (;;) {
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] === "/" && text[k + 1] === "/") {
          while (k < n && text[k] !== "\n") k++;
        } else if (text[k] === "/" && text[k + 1] === "*") {
          const end = text.indexOf("*/", k + 2);
          k = end < 0 ? n : end + 2;
        } else break;
      }
      if (text[k] === "}" || text[k] === "]") { i++; continue; }
    }
    out += ch;
    i++;
  }
  return out;
}

export function parseJsonc(text) {
  const parsed = JSON.parse(stripJsonc(text));
  // $id-only placeholder slots are dropped, matching upstream semantics.
  const clean = (v) => {
    if (Array.isArray(v)) {
      return v.filter((item) => !(item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).every((k) => k === "$id"))).map(clean);
    }
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) v[k] = clean(v[k]);
    }
    return v;
  };
  return clean(parsed);
}

// ---------- env interpolation ----------

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;

export function interpolateEnv(value, env = process.env) {
  if (typeof value !== "string") return value;
  return value.replace(ENV_RE, (_, name, fallback) => {
    const v = env[name];
    if (v != null && v !== "") return v;
    return fallback ?? "";
  });
}

function interpolateDeep(value, env) {
  if (typeof value === "string") return interpolateEnv(value, env);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, env));
  if (value != null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateDeep(v, env);
    return out;
  }
  return value;
}

// ---------- loading & merging ----------

function mergeByKey(bundled = [], override = [], key) {
  const map = new Map();
  for (const item of bundled) map.set(item[key], item);
  for (const item of override) {
    const prev = map.get(item[key]);
    map.set(item[key], prev ? { ...prev, ...item } : item);
  }
  return [...map.values()];
}

export function loadRouterConfig({ bundledPath, userPath, env = process.env } = {}) {
  const bundledFile = bundledPath ?? join(PLUGIN_ROOT, "router-config.jsonc");
  const userFile = userPath ?? join(tokensaverHome(), "router-config.jsonc");
  let raw = {};
  if (existsSync(bundledFile)) raw = parseJsonc(readFileSync(bundledFile, "utf8"));
  let user = {};
  if (existsSync(userFile)) user = parseJsonc(readFileSync(userFile, "utf8"));
  const merged = {
    ...raw,
    ...user,
    providers: mergeByKey(raw.providers, user.providers, "id"),
    models: mergeByKey(raw.models, user.models, "id"),
    bindings: mergeByKey(raw.bindings, user.bindings, "label"),
    routingPresets: mergeByKey(raw.routingPresets, user.routingPresets, "path"),
  };
  return interpolateDeep(merged, env);
}

// ---------- resolution ----------

export function presetForPath(config, path) {
  return config.routingPresets?.find((p) => p.path === path);
}

export function providerById(config, id) {
  return config.providers?.find((p) => p.id === id);
}

// providerSelectors: first selector whose `when` matches the inbound headers wins.
export function selectProvider(config, preset, headers) {
  for (const sel of preset.providerSelectors ?? []) {
    const when = sel.when ?? {};
    if (when.headerPresent != null && headers[when.headerPresent.toLowerCase()] == null) continue;
    return providerById(config, sel.provider) ?? providerById(config, preset.defaultProvider);
  }
  return providerById(config, preset.defaultProvider);
}

// ---------- model mapping ----------

function wildcardMatch(pattern, value) {
  if (pattern === value) return true;
  const re = new RegExp(
    "^" + pattern.split("*").map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    "i",
  );
  return re.test(value);
}

// modelMappings entries: {model: "*haiku*", target: "..."} — first match wins.
export function mapModel(mappings, model) {
  if (!Array.isArray(mappings) || typeof model !== "string") return model;
  for (const m of mappings) {
    if (typeof m?.model === "string" && typeof m?.target === "string" && wildcardMatch(m.model, model)) {
      return m.target;
    }
  }
  return model;
}

// Effective model mapping for a preset call: preset-level mappings take
// precedence over provider-level ones.
export function resolveModel(config, preset, provider, inboundModel) {
  const fromPreset = mapModel(preset?.modelMappings, inboundModel);
  if (fromPreset !== inboundModel) return fromPreset;
  return mapModel(provider?.modelMappings, inboundModel);
}
