// Path helpers: normalization, resolution vs session cwd, protected paths,
// and the ipynb shadow-file guard.
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { existsSync, readdirSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { loadProjectFlags } from "./config.mjs";

const ALWAYS_PROTECTED = ["/node_modules/", "/.git/"];

export function normalizePath(p) {
  let out = normalize(p).split(sep).join("/");
  if (out.startsWith("//?/")) out = out.slice(4);
  return out;
}

export function resolveSessionPath(filePath, cwd) {
  if (isAbsolute(filePath)) return normalizePath(filePath);
  return normalizePath(resolve(cwd, filePath));
}

// Resolve existing parents as well, so newly created files behind a junction
// receive the same protection as files addressed by their real path.
export function canonicalPath(filePath, depth = 0) {
  if (depth > 128) throw new Error("Cannot resolve path: too many parent or symbolic-link levels");
  const absolute = resolve(filePath);
  try { return realpathSync.native(absolute); } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
    let link;
    try { if (lstatSync(absolute).isSymbolicLink()) link = readlinkSync(absolute); } catch (linkError) {
      if (linkError.code !== "ENOENT" && linkError.code !== "ENOTDIR") throw linkError;
    }
    if (link != null) return canonicalPath(resolve(dirname(absolute), link), depth + 1);
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonicalPath(parent, depth + 1), basename(absolute));
  }
}

// Returns the matched protected fragment, or undefined when writable.
export function protectedPathReason(absPath, cwd) {
  const fold = (p) => process.platform === "win32" ? p.toLowerCase() : p;
  const norms = [absPath, canonicalPath(absPath)].map((p) => fold("/" + normalizePath(p).replace(/^\/+/, "") + "/"));
  for (const frag of ALWAYS_PROTECTED) {
    if (norms.some((norm) => norm.includes(frag))) return frag;
  }
  const flags = loadProjectFlags(cwd);
  if (flags.protectFiles !== false && Array.isArray(flags.protectedPaths)) {
    for (const extra of flags.protectedPaths) {
      if (typeof extra !== "string" || !extra) continue;
      const needle = fold(normalizePath(extra));
      if (norms.some((norm) => norm.includes(needle))) return extra;
    }
  }
  return undefined;
}

// Refuse creating `x.py` (or any non-ipynb code file) when a sibling
// `x.ipynb` exists in the same directory — matches upstream behavior.
export function ipynbShadowConflict(absPath) {
  if (absPath.toLowerCase().endsWith(".ipynb")) return undefined;
  const dir = dirname(absPath);
  const stem = basename(absPath).toLowerCase().replace(/\.[^.]+$/, "");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  return entries.find((e) => e.toLowerCase() === stem + ".ipynb");
}

export function pathExists(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
