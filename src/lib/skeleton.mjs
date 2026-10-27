// AST skeleton view: keep every line except the interior of declaration
// bodies — signatures, imports, comments and top-level code stay, bodies
// collapse to a `⋮ N lines` marker. Enough for "what does this file expose"
// without a full read.
//
// Language-agnostic by design: grammars name body nodes differently
// (block / class_body / statement_block / compound_statement / …) but the
// rule is uniform — a multi-line body node drops its interior lines.
import { getParser, getLanguage, EXT_LANGUAGE } from "./syntax.mjs";

// Extension → grammar, extending the syntax-check map with the JS family
// (syntax checks keep `node --check`, skeletons use the javascript grammar).
const SKELETON_LANGUAGE = {
  ...EXT_LANGUAGE,
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

// Field lists (struct fields, enum variants) are NOT body types — they're
// the signature, not the body.
const BODY_TYPES = new Set([
  "block", "class_body", "statement_block", "compound_statement",
  "declaration_list", "initializer_list", "literal_value", "object",
]);

// Bodies owned by these nodes hold declarations (methods, nested types) and
// recurse so their signatures stay visible. Every other body — function,
// method, callback, top-level if/for, object literal — folds whole, even
// when it nests further blocks: folding only leaf bodies kept React
// components and script-style modules at ~85% of their size.
const CONTAINER_PARENT_RE = /class|interface|impl_item|trait|namespace|module|mod_item/;

const MIN_ELIDED_LINES = 2; // a marker shorter than the body isn't a saving

// A body node drops either all its lines (it starts on a fresh line —
// python `block` after `def f():`) or its interior (it shares its first
// line with the parent signature — `{` after `class A`). The closing line
// is kept only when it's pure closers — python blocks end on a real
// statement, which belongs to the elided interior.
function bodyRanges(root, lines) {
  const ranges = [];
  const visit = (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!BODY_TYPES.has(child.type) || CONTAINER_PARENT_RE.test(node.type)) {
        visit(child);
        continue;
      }
      const { row: s, column: c } = child.startPosition;
      const { row: e } = child.endPosition;
      if (e <= s) continue;
      const freshLine = (lines[s] ?? "").slice(0, c).trim() === "";
      const dropStart = freshLine ? s : s + 1;
      const endIsCloser = /^[}\)\];,]*$/.test((lines[e] ?? "").trim());
      const dropEnd = endIsCloser ? e - 1 : e;
      if (dropEnd - dropStart + 1 >= MIN_ELIDED_LINES) ranges.push([dropStart, dropEnd]);
    }
  };
  visit(root);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

const extOf = (absPath) => absPath.slice(absPath.lastIndexOf(".")).toLowerCase();

export function canSkeletonize(absPath) {
  return SKELETON_LANGUAGE[extOf(absPath)] != null;
}

// Returns the skeleton text, or null when the extension has no grammar or
// parsing fails — callers fall back to the heuristic summarizer.
export async function skeletonize(absPath, content) {
  const grammar = SKELETON_LANGUAGE[extOf(absPath)];
  if (grammar == null) return null;
  try {
    const parser = await getParser();
    const language = await getLanguage(grammar);
    if (language == null) return null;
    parser.setLanguage(language);
    const lines = content.split("\n");
    const elided = bodyRanges(parser.parse(content).rootNode, lines);
    if (elided.length === 0) return null; // nothing to fold — full file is already a skeleton
    const out = [];
    let cursor = 0;
    for (const [s, e] of elided) {
      for (let i = cursor; i < s; i++) out.push(lines[i]);
      const indent = (lines[s - 1]?.match(/^\s*/) ?? [""])[0];
      out.push(`${indent}  ⋮ ${e - s + 1} lines`);
      cursor = e + 1;
    }
    for (let i = cursor; i < lines.length; i++) out.push(lines[i]);
    return out.join("\n");
  } catch {
    return null;
  }
}
