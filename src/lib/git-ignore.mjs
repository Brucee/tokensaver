import ignore from "ignore";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function repositoryRoot(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

function within(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../");
}

// New instance per Search call: edits to ignore rules take effect immediately.
// This handles project .gitignore files, not global Git excludes or tracked status.
export function createGitIgnoreFilter(cwd) {
  const root = repositoryRoot(cwd) ?? resolve(cwd);
  const states = new Map();
  const externalRoots = new Map();
  function matches(rules, path, directory) {
    let ignored = false;
    for (const rule of rules) {
      const rel = relative(rule.dir, path).replace(/\\/g, "/");
      if (!rel || !within(rule.dir, path)) continue;
      const result = rule.matcher.test(rel + (directory ? "/" : ""));
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }
  function state(dir, boundary) {
    if (states.has(dir)) return states.get(dir);
    const parent = dir === boundary ? { blocked: false, rules: [] } : state(dirname(dir), boundary);
    const blocked = parent.blocked || matches(parent.rules, dir, true);
    const rules = [...parent.rules];
    if (!blocked) {
      try { rules.push({ dir, matcher: ignore({ ignorecase: process.platform === "win32" }).add(readFileSync(join(dir, ".gitignore"), "utf8")) }); }
      catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    }
    const result = { blocked, rules };
    states.set(dir, result);
    return result;
  }
  return (path, directory = false) => {
    path = resolve(path);
    if (path === root) return false;
    let boundary = root;
    if (!within(root, path)) {
      const parent = dirname(path);
      if (!externalRoots.has(parent)) externalRoots.set(parent, repositoryRoot(parent) ?? parent);
      boundary = externalRoots.get(parent);
    }
    const parent = state(dirname(path), boundary);
    return parent.blocked || matches(parent.rules, path, directory);
  };
}
