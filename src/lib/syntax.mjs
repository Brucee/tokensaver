// Advisory syntax checking via tree-sitter WASM grammars.
//
// For languages without a native `node --check` path, we parse the edited
// content with real grammars and surface ERROR/MISSING nodes as
// {line, column, message} problems — the same advisory shape the Edit tool
// already renders ("Syntax errors:" appended to the result).
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GRAMMARS_DIR = join(PLUGIN_ROOT, "grammars");

// Extension → vendored grammar wasm (without the "tree-sitter-" prefix).
const EXT_LANGUAGE = {
  ".py": "python",
  ".java": "java",
  ".rs": "rust",
  ".php": "php",
  ".ts": "typescript",
  ".cts": "typescript",
  ".mts": "typescript",
  ".tsx": "tsx",
  ".jsx": "tsx",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
};

let parserPromise;
const languageCache = new Map();

export { EXT_LANGUAGE };

export async function getParser() {
  parserPromise ??= import("web-tree-sitter").then(async ({ Parser }) => {
    await Parser.init();
    return new Parser();
  });
  return parserPromise;
}

export async function getLanguage(grammar) {
  if (!languageCache.has(grammar)) {
    const file = join(GRAMMARS_DIR, `tree-sitter-${grammar}.wasm`);
    if (!existsSync(file)) return undefined;
    languageCache.set(
      grammar,
      import("web-tree-sitter").then(({ Language }) => Language.load(file)),
    );
  }
  return languageCache.get(grammar);
}

function collectProblems(root, out, max = 5) {
  const stack = [root];
  while (stack.length && out.length < max) {
    const node = stack.pop();
    if (node.type === "ERROR" || node.isMissing) {
      const snippet = node.text.replace(/\s+/g, " ").trim().slice(0, 40);
      out.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        message: node.isMissing
          ? `missing ${node.type}`
          : `unexpected ${snippet ? `"${snippet}"` : "input"}`,
      });
      continue;
    }
    for (let i = node.childCount - 1; i >= 0; i--) stack.push(node.child(i));
  }
  return out;
}

// JS-family files keep `node --check` — its diagnostics are better than a
// generic ERROR node. Everything else in EXT_LANGUAGE goes through the parser.
const NODE_CHECK_EXTS = new Set([".js", ".mjs", ".cjs"]);

// .js resolves like Node itself: "module" only when the nearest package.json
// says so — otherwise commonjs (top-level return/require are valid there).
const pkgTypeCache = new Map();
function moduleKindFor(absPath) {
  if (absPath.endsWith(".mjs")) return "module";
  if (absPath.endsWith(".cjs")) return "commonjs";
  const dir = dirname(absPath);
  const hit = pkgTypeCache.get(dir);
  if (hit) return hit;
  let kind = "commonjs";
  for (let d = dir; ; d = dirname(d)) {
    try {
      if (JSON.parse(readFileSync(join(d, "package.json"), "utf8")).type === "module") kind = "module";
      break;
    } catch {
      const parent = dirname(d);
      if (parent === d) break;
    }
  }
  pkgTypeCache.set(dir, kind);
  return kind;
}

function nodeCheck(absPath, content) {
  const kind = moduleKindFor(absPath);
  try {
    execFileSync(process.execPath, ["--check", `--input-type=${kind}`, "-"], {
      input: content,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    return [];
  } catch (e) {
    const msg = String(e.stderr ?? e.message).split("\n").filter(Boolean).pop() ?? "syntax error";
    const m = /:(\d+)/.exec(String(e.stderr ?? ""));
    return [{ line: m ? parseInt(m[1], 10) : 1, column: undefined, message: msg.replace(/^.*?:\d+\s*/, "") }];
  }
}

export function isCheckable(absPath) {
  const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase();
  return NODE_CHECK_EXTS.has(ext) || EXT_LANGUAGE[ext] != null;
}

// Returns [{line, column, message}] — empty array when clean or unchecked.
export async function checkSyntax(absPath, content) {
  const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase();
  if (NODE_CHECK_EXTS.has(ext)) return nodeCheck(absPath, content);
  const grammar = EXT_LANGUAGE[ext];
  if (grammar == null) return [];
  try {
    const parser = await getParser(); // Parser.init must land before Language.load
    const language = await getLanguage(grammar);
    if (language == null) return [];
    parser.setLanguage(language);
    const tree = parser.parse(content);
    try {
      return tree.rootNode.hasError ? collectProblems(tree.rootNode, []) : [];
    } finally {
      tree.delete(); // WASM memory is not GC'd — release the tree
    }
  } catch (e) {
    if (process.env.TOKENSAVER_DEBUG_SYNTAX) console.error("syntax check failed:", e);
    return []; // advisory — a broken parser must never fail an edit
  }
}
