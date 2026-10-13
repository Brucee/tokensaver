// Collect the review bundle: committed diff vs base branch, staged diff,
// unstaged diff, and untracked file contents — everything a reviewer needs
// to see the full change being made, not just what is committed.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { collectRepoContext } from "./review-context.mjs";

const BUNDLE_CAP = 60000; // chars — keep the bundle small enough to fan out
const UNTRACKED_FILE_CAP = 400; // lines per untracked file
const UNTRACKED_MAX_FILES = 20;
const UNTRACKED_MAX_BYTES = 100_000; // skip binaries/large dumps

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
}

function detectBase(cwd) {
  const originHead = tryGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead; // e.g. origin/main
  for (const cand of ["main", "master"]) {
    if (tryGit(cwd, ["rev-parse", "--verify", cand])) return cand;
  }
  return null;
}

function isBinaryish(buf) {
  return buf.subarray(0, 8000).includes(0);
}

// --- file classification → proportional lens selection ---
// Deterministic pre-pass: docs-only diffs don't need 7 reviewers, and
// config-only changes only need the lenses that can implicate them.
const CATEGORY_EXT = {
  code: /\.(m?[jt]sx?|cjs|py|php|java|rs|go|c|h|cpp|cc|cxx|hpp|hh|rb|cs|swift|kt|kts|scala|lua|pl|sh|ps1|sql)$/i,
  docs: /\.(md|mdx|txt|rst|adoc)$/i,
  config: /\.(json|jsonc|ya?ml|toml|ini|xml|env|cfg|conf|lock|editorconfig|gitignore|npmrc|dockerfile|makefile)$/i,
  styles: /\.(css|scss|sass|less|styl)$/i,
  assets: /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp[34]|wav|wasm|pdf|zip|gz)$/i,
};
const TEST_PATH = /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[^.]+$/i;

const ALL_LENSES = [
  "correctness",
  "cross-file-consistency",
  "duplication",
  "existing-code-reuse",
  "type-safety",
  "sdk-and-schema-reuse",
  "comment-hygiene",
];

export function classifyFile(path) {
  const base = path.toLowerCase();
  if (/\.md$/.test(base) && (/(^|\/)(agents|skills|rules|commands)\//.test(base) || /(^|\/)(agents|claude|skill)\.md$/.test(base))) return "config";
  if (TEST_PATH.test(base)) return "test";
  for (const [cat, re] of Object.entries(CATEGORY_EXT)) {
    if (re.test(base)) return cat;
  }
  return "other";
}

// Which lenses can actually fire on this file mix.
export function suggestLenses(byCategory, { changedLines = Infinity } = {}) {
  const has = (c) => (byCategory[c]?.length ?? 0) > 0;
  const fileCount = Object.values(byCategory).reduce((n, files) => n + files.length, 0);
  if ((has("code") || has("test")) && changedLines <= 80 && fileCount <= 3) {
    return ["correctness", "cross-file-consistency", "type-safety"];
  }
  if (has("code") || has("test")) return [...ALL_LENSES];
  if (has("config") || has("other")) return ["correctness", "cross-file-consistency"];
  return []; // docs/styles/assets only — nothing a code lens can implicate
}

// Returns { ok, error?, base?, committed?, staged?, unstaged?, untracked?, files?, suggestedLenses? }
export function collectReviewBundle({ cwd = process.cwd(), base } = {}) {
  try {
    git(cwd, ["rev-parse", "--git-dir"]);
  } catch (e) {
    // Distinguish "git itself says no repo" (exit code) from "git could not
    // be spawned at all" — e.g. Codex's Windows sandbox lets only the
    // sanctioned shell create child processes, so node→git fails EPERM
    // even though `git` works from the shell. Callers then fall back to
    // running git directly via exec.
    if (e.code) return { ok: false, error: `cannot spawn git (${e.code}): sandboxed shells can run git directly — fetch the diff with raw git commands instead` };
    return { ok: false, error: "not a git repository" };
  }
  const resolvedBase = base ?? detectBase(cwd);
  let committed = "";
  let mergeBase = null;
  if (resolvedBase) {
    mergeBase = tryGit(cwd, ["merge-base", "HEAD", resolvedBase]) || null;
    if (mergeBase) committed = git(cwd, ["diff", `${mergeBase}...HEAD`, "--", "."]);
  }
  const staged = tryGit(cwd, ["diff", "--cached"]);
  const unstaged = tryGit(cwd, ["diff"]);
  const changedNames = new Set();
  if (mergeBase) {
    for (const n of tryGit(cwd, ["diff", "--name-only", `${mergeBase}...HEAD`]).split("\n")) changedNames.add(n);
  }
  for (const args of [["diff", "--cached", "--name-only"], ["diff", "--name-only"]]) {
    for (const n of tryGit(cwd, args).split("\n")) changedNames.add(n);
  }
  const untracked = [];
  const allUntrackedNames = tryGit(cwd, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean);
  const names = allUntrackedNames.slice(0, UNTRACKED_MAX_FILES);
  const untrackedDropped = allUntrackedNames.length - names.length;
  for (const name of names) {
    try {
      const abs = join(cwd, name);
      if (statSync(abs).size > UNTRACKED_MAX_BYTES) {
        untracked.push({ path: name, content: "[skipped: file too large]" });
        continue;
      }
      const buf = readFileSync(abs);
      if (isBinaryish(buf)) {
        untracked.push({ path: name, content: "[skipped: binary file]" });
        continue;
      }
      const lines = buf.toString("utf8").split("\n");
      const content =
        lines.length > UNTRACKED_FILE_CAP
          ? lines.slice(0, UNTRACKED_FILE_CAP).join("\n") + `\n[truncated: ${lines.length - UNTRACKED_FILE_CAP} more lines]`
          : buf.toString("utf8");
      untracked.push({ path: name, content });
    } catch {}
  }
  for (const name of allUntrackedNames) changedNames.add(name);
  changedNames.delete("");
  const byCategory = {};
  for (const name of changedNames) {
    const cat = classifyFile(name);
    (byCategory[cat] ??= []).push(name);
  }
  const incomplete = untrackedDropped > 0 || untracked.length < names.length || untracked.some((f) => /\[(skipped|truncated):/.test(f.content));
  const changedLines = incomplete ? Infinity :
    [committed, staged, unstaged].reduce((n, diff) => n + diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(---|\+\+\+)/.test(l)).length, 0) +
    untracked.reduce((n, f) => n + f.content.split("\n").length, 0);
  const suggestedLenses = changedNames.size ? suggestLenses(byCategory, { changedLines }) : [];
  const all = [...changedNames].sort();
  return {
    ok: true,
    base: mergeBase ?? resolvedBase,
    baseName: resolvedBase,
    committed, staged, unstaged, untracked,
    untrackedDropped,
    files: { all, byCategory },
    suggestedLenses,
    context: collectRepoContext({ cwd, files: all }),
  };
}

// Render the bundle as a single markdown document for reviewer fan-out.
export function formatReviewBundle(bundle) {
  if (!bundle.ok) return `# Review bundle\n\nError: ${bundle.error}`;
  const parts = ["# Review bundle", ""];
  if (bundle.baseName) parts.push(`Base: \`${bundle.baseName}\` (${bundle.base?.slice(0, 12) ?? "?"})`, "");
  if (bundle.files?.all?.length) {
    const counts = Object.entries(bundle.files.byCategory)
      .map(([c, l]) => `${l.length} ${c}`)
      .join(", ");
    parts.push(`Files: ${bundle.files.all.length} changed (${counts})`, "");
    parts.push(`suggested_lenses: ${bundle.suggestedLenses.join(",") || "none"}`, "");
  }
  const section = (title, body) => {
    if (body) parts.push(`## ${title}`, "", "```diff", body, "```", "");
  };
  const hasChanges = !!(bundle.committed || bundle.staged || bundle.unstaged || bundle.untracked?.length);
  section("Committed changes vs base", bundle.committed);
  section("Staged (uncommitted)", bundle.staged);
  section("Unstaged working-tree changes", bundle.unstaged);
  if (bundle.untracked?.length) {
    parts.push("## Untracked new files", "");
    for (const f of bundle.untracked) {
      parts.push(`### ${f.path}`, "", "```", f.content, "```", "");
    }
  }
  if (bundle.untrackedDropped > 0) {
    parts.push(
      `_Note: ${bundle.untrackedDropped} more untracked file(s) were omitted (cap ${UNTRACKED_MAX_FILES}) — review them separately._`,
      "",
    );
  }
  const ctx = bundle.context;
  if (ctx && (ctx.alwaysOn.length || ctx.scoped.length || ctx.tooling.length)) {
    parts.push("## Repo conventions", "");
    for (const r of ctx.alwaysOn) parts.push(`### ${r.path}`, "", r.body, "");
    for (const r of ctx.scoped) {
      parts.push(`### ${r.path} (matches: ${r.matchedFiles.join(", ")})`, "", r.body, "");
    }
    if (ctx.tooling.length) parts.push(`Tooling detected: ${ctx.tooling.join(", ")}`, "");
  }
  if (!hasChanges) parts.push("_No changes to review._");
  let out = parts.join("\n");
  if (out.length > BUNDLE_CAP) out = out.slice(0, BUNDLE_CAP) + "\n\n[bundle truncated]";
  return out;
}
