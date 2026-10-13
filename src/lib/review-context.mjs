// Repo conventions for reviewers: project-specific rules the generic
// lenses can't know. Prefetched and filtered by the diff's file list —
// no embeddings, no extra LLM calls.
//
// Sources, in order:
//   1. Always-on docs (CLAUDE.md, AGENTS.md, CONVENTIONS.md, copilot-instructions)
//   2. Glob-scoped rule files (.cursor/rules/*.mdc, .ai/rules/*.md, .windsurf/rules/*)
//      — frontmatter `globs:` matched against changed files, `alwaysApply: true`
//      included unconditionally.
//   3. Deterministic tooling hints from config files (eslint, prettier, …).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { globMatch } from "./glob.mjs";

const ALWAYS_ON = ["CLAUDE.md", "AGENTS.md", "CONVENTIONS.md", ".github/copilot-instructions.md"];
const RULE_DIRS = [".cursor/rules", ".ai/rules", ".windsurf/rules", "docs/ai/rules"];
const RULE_EXTS = new Set([".md", ".mdc"]);
const FILE_CAP = 2000;
const TOOLING = [
  [/eslint\.config\.|\.eslintrc/, "eslint"],
  [/prettier\.config\.|\.prettierrc/, "prettier"],
  [/^\.editorconfig$/, "editorconfig"],
  [/^tsconfig.*\.json$/, "tsconfig"],
  [/ruff\.toml|\.flake8|mypy\.ini/, "python-lint"],
  [/phpstan.*\.neon|\.php-cs-fixer/, "php-lint"],
  [/rustfmt\.toml|clippy\.toml/, "rust-lint"],
];

function readCapped(path) {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > FILE_CAP ? text.slice(0, FILE_CAP) + "\n[truncated]" : text;
  } catch {
    return null;
  }
}

// Minimal frontmatter: { globs: [...], alwaysApply: bool, body }
function parseRule(text) {
  if (!text.startsWith("---")) return { globs: [], alwaysApply: false, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { globs: [], alwaysApply: false, body: text };
  const fm = text.slice(3, end);
  const body = text.slice(end + 4).trim();
  const globs = [];
  let alwaysApply = false;
  let inGlobs = false;
  for (const line of fm.split("\n")) {
    const listItem = /^\s+-\s+["']?(.+?)["']?\s*$/.exec(line);
    if (inGlobs && listItem) {
      globs.push(listItem[1]);
      continue;
    }
    inGlobs = false;
    const g = /^globs?\s*:\s*(.*)$/.exec(line.trim());
    if (g) {
      const v = g[1].trim();
      if (v.startsWith("[")) {
        for (const m of v.matchAll(/["']([^"']+)["']/g)) globs.push(m[1]);
        if (globs.length === 0) globs.push(...v.replace(/[\[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean));
      } else if (v) globs.push(v.replace(/^["']|["']$/g, ""));
      else inGlobs = true;
    }
    if (/^alwaysApply\s*:\s*true/i.test(line.trim())) alwaysApply = true;
  }
  return { globs, alwaysApply, body };
}

function listRuleFiles(cwd) {
  const files = [];
  for (const dir of RULE_DIRS) {
    const abs = join(cwd, dir);
    try {
      for (const name of readdirSync(abs)) {
        if (RULE_EXTS.has(extname(name).toLowerCase())) files.push(join(dir, name));
      }
    } catch {}
  }
  return files;
}

function detectTooling(cwd) {
  const found = new Set();
  let names = [];
  try {
    names = readdirSync(cwd);
  } catch {
    return [];
  }
  for (const name of names) {
    for (const [re, tool] of TOOLING) if (re.test(name)) found.add(tool);
  }
  return [...found];
}

// collectRepoContext({cwd, files}) → { alwaysOn, scoped, tooling }
export function collectRepoContext({ cwd = process.cwd(), files = [] } = {}) {
  const alwaysOn = [];
  for (const name of ALWAYS_ON) {
    const body = readCapped(join(cwd, name));
    if (body) alwaysOn.push({ path: name, body });
  }
  const scoped = [];
  for (const rel of listRuleFiles(cwd)) {
    let raw;
    try {
      raw = readFileSync(join(cwd, rel), "utf8");
    } catch {
      continue;
    }
    const rule = parseRule(raw);
    const body = rule.body.length > FILE_CAP ? rule.body.slice(0, FILE_CAP) + "\n[truncated]" : rule.body;
    if (!body) continue;
    if (rule.alwaysApply || rule.globs.length === 0) {
      alwaysOn.push({ path: rel, body });
      continue;
    }
    const matched = files.filter((f) => rule.globs.some((g) => globMatch(g, f)));
    if (matched.length > 0) scoped.push({ path: rel, body, matchedFiles: matched });
  }
  return { alwaysOn, scoped, tooling: detectTooling(cwd) };
}
