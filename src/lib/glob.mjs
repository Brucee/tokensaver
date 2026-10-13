// Minimal glob engine: **, *, ?, [...], {a,b} — enough for the Search tool
// surface without pulling a dependency.
import { normalizePath } from "./paths.mjs";

export function globToRegex(pattern) {
  let re = "";
  let i = 0;
  const n = pattern.length;
  const pushClass = () => {
    let j = i + 1;
    let body = "";
    if (pattern[j] === "!") {
      body += "^";
      j++;
    }
    for (; j < n && pattern[j] !== "]"; j++) {
      body += pattern[j] === "\\" ? "\\\\" : pattern[j];
    }
    re += "[" + body + "]";
    i = j;
  };
  const pushBrace = () => {
    let depth = 1;
    let j = i + 1;
    let body = "";
    for (; j < n && depth > 0; j++) {
      const c = pattern[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
      if (c === "," && depth === 1) body += "|";
      else body += c === "\\" ? "\\\\" : c;
    }
    const inner = body
      .split("|")
      .map((alt) => globToRegex(alt).source.replace(/^\^/, "").replace(/\$$/, ""))
      .join("|");
    re += "(?:" + inner + ")";
    i = j;
  };
  for (; i < n; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const prevSlash = pattern[i - 1] === "/";
        const nextSlash = pattern[i + 2] === "/";
        i++;
        if (nextSlash) {
          i++;
          re += prevSlash ? "(?:[^/]*/)*" : "[^/]*(?:[^/]*/)*";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      pushClass();
    } else if (c === "{") {
      pushBrace();
    } else {
      re += c.replace(/[.+^$()|\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

export function isGlobPattern(p) {
  return /[*?{[]/.test(p);
}

export function globMatch(pattern, relPath) {
  return globToRegex(normalizePath(pattern)).test(normalizePath(relPath));
}

// Static prefix of a glob before the first meta char — the directory to
// start walking from.
export function globBase(pattern) {
  const norm = normalizePath(pattern);
  const parts = norm.split("/");
  let base = "";
  for (const part of parts) {
    if (/[*?{[]/.test(part)) break;
    base += part + "/";
  }
  return base.replace(/\/$/, "") || ".";
}
