// Sql connection policy — read from "tokensaver.sql" inside the host's
// settings file (~/.claude/settings.json on Claude, host-settings.json under
// the plugin home elsewhere). deny rules win, then allow rules, then the
// default action. An invalid policy denies every connection until fixed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getHost } from "../host/index.mjs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_DIALECTS = new Set(["sqlite", "duckdb"]);

function globMatch(pattern, value) {
  const re = new RegExp("^" + pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(value.toLowerCase());
}

function list(v) {
  return Array.isArray(v) ? v : [v];
}

function ruleMatches(rule, target) {
  if (rule === "local" || rule === "remote") return target.scope === rule;
  if (rule == null || typeof rule !== "object") return false;
  let matched = false;
  if (rule.dialect != null) {
    if (target.dialect == null || !list(rule.dialect).includes(target.dialect)) return false;
    matched = true;
  }
  if (rule.host != null) {
    if (target.host == null || !list(rule.host).some((h) => globMatch(String(h), target.host))) return false;
    matched = true;
  }
  return matched;
}

function describeRule(rule) {
  if (typeof rule === "string") return `'${rule}'`;
  const parts = [];
  if (rule.dialect != null) parts.push("dialect=" + list(rule.dialect).join(","));
  if (rule.host != null) parts.push("host=" + list(rule.host).join(","));
  return "{ " + parts.join(", ") + " }";
}

function matchAny(rules, target) {
  for (const rule of rules ?? []) {
    if (ruleMatches(rule, target)) return rule;
  }
  return undefined;
}

export function evaluatePolicy(policy, target) {
  const deny = matchAny(policy.deny, target);
  if (deny != null) return { allowed: false, reason: "deny rule " + describeRule(deny) };
  if (Array.isArray(policy.allow) && policy.allow.length > 0) {
    const allow = matchAny(policy.allow, target);
    if (allow != null) return { allowed: true, reason: "allow rule " + describeRule(allow) };
  }
  const def = policy.default ?? "allow";
  return { allowed: def === "allow", reason: "default " + def };
}

const RULE_KEYS = new Set(["dialect", "host"]);

function validateRule(rule) {
  if (typeof rule === "string") return rule === "local" || rule === "remote" ? undefined : `rule '${rule}' must be "local" or "remote"`;
  if (rule == null || typeof rule !== "object" || Array.isArray(rule)) return "rules must be \"local\", \"remote\", or objects";
  if (Object.keys(rule).length === 0) return "rule objects must include dialect or host";
  for (const k of Object.keys(rule)) {
    if (!RULE_KEYS.has(k)) return `unknown rule key "${k}"`;
    if (list(rule[k]).length === 0 || list(rule[k]).some((v) => typeof v !== "string" || v.length === 0)) return `${k}: expected a non-empty string or array of strings`;
  }
  return undefined;
}

// → { status: "absent" } | { status: "invalid", error } | { status: "valid", policy }
export function loadSqlPolicy() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(getHost().hostSettingsFile(), "utf8"));
  } catch (e) {
    // Missing file → no policy. Corrupt file → invalid, so deny-all wins
    // over silently dropping the user's deny rules.
    if (e instanceof SyntaxError) return { status: "invalid", error: "settings file is not valid JSON" };
    return e.code === "ENOENT" ? { status: "absent" } : { status: "invalid", error: "cannot read settings file" };
  }
  const policy = raw?.tokensaver?.sql;
  if (policy == null) return { status: "absent" };
  if (typeof policy !== "object" || Array.isArray(policy)) {
    return { status: "invalid", error: "(root): expected an object" };
  }
  for (const key of Object.keys(policy)) {
    if (!["deny", "allow", "default", "duckdb"].includes(key)) {
      return { status: "invalid", error: `(root): unknown key "${key}"` };
    }
  }
  for (const key of ["deny", "allow"]) {
    const rules = policy[key];
    if (rules == null) continue;
    if (!Array.isArray(rules)) return { status: "invalid", error: `${key}: expected an array of rules` };
    for (const rule of rules) {
      const err = validateRule(rule);
      if (err) return { status: "invalid", error: `${key}: ${err}` };
    }
  }
  if (policy.default != null && policy.default !== "allow" && policy.default !== "deny") {
    return { status: "invalid", error: `default: must be "allow" or "deny"` };
  }
  if (policy.duckdb != null && (typeof policy.duckdb !== "object" || Array.isArray(policy.duckdb))) {
    return { status: "invalid", error: `duckdb: expected an object` };
  }
  for (const [key, value] of Object.entries(policy.duckdb ?? {})) {
    if (key === "fileWrites" && typeof value === "boolean") continue;
    if (key === "allowedDirectories" && Array.isArray(value) && value.every((p) => typeof p === "string" && p.length > 0)) continue;
    return { status: "invalid", error: `duckdb.${key}: unknown key or invalid value` };
  }
  return { status: "valid", policy };
}

// Build the policy target for a connection descriptor.
export function policyTarget(dialect, host) {
  if (LOCAL_DIALECTS.has(dialect)) return { dialect, scope: "local" };
  // Unparseable/empty host on a network dialect defaults to remote — the
  // safer scope: "local" must be proven, not assumed.
  const scope = host != null && LOCAL_HOSTS.has(host) ? "local" : "remote";
  return { dialect, host, scope };
}

// Throws when the policy blocks the connection; no-op otherwise.
export function enforceSqlPolicy(dialect, host) {
  let loaded;
  try {
    loaded = loadSqlPolicy();
  } catch {
    throw new Error("Sql tool blocked: unable to evaluate the connection policy.");
  }
  const target = policyTarget(dialect, host);
  const settingsFile = getHost().hostSettingsFile();
  if (loaded.status === "invalid") {
    throw new Error(
      `Sql tool blocked: your "tokensaver.sql" policy in ${settingsFile} is invalid, so connections are denied until it is fixed (${loaded.error}).`
    );
  }
  if (loaded.status === "absent") return;
  const verdict = evaluatePolicy(loaded.policy, target);
  if (!verdict.allowed) {
    throw new Error(
      `Sql tool blocked by policy: ${target.dialect ?? "database"} connection to host '${target.host ?? "(local)"}' is denied by your tokensaver.sql policy (${verdict.reason}). Adjust "tokensaver.sql" in ${settingsFile}.`
    );
  }
}

export function duckdbPolicy() {
  const loaded = loadSqlPolicy();
  return loaded.status === "valid" ? loaded.policy.duckdb ?? {} : {};
}
