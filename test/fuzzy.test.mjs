import { test } from "node:test";
import assert from "node:assert/strict";
import { similarity, fuzzyFind, indentRewrite, anchorTokens } from "../src/lib/fuzzy.mjs";
import { normalizeText, unmapOffset, needsNormalize } from "../src/lib/textnorm.mjs";
import { splitKeepNewline } from "../src/lib/lineio.mjs";
import { expandWildcard, parseLineRangeSuffix, parseCellSuffix, expandOmitTags, replaceOmitTagOnce } from "../src/lib/elision.mjs";

test("similarity: identical → 1, empty handling", () => {
  assert.equal(similarity("abc", "abc"), 1);
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("abc", ""), 0);
  assert.equal(similarity("ABC", "abc", false), 1);
  assert.ok(similarity("abc", "abd") > 0.5);
});

test("fuzzyFind: exact block match inside larger file", () => {
  const file = splitKeepNewline("a\nb\nc\nd\ne\nf\ng\nh\n");
  const target = splitKeepNewline("c\nd\ne\n");
  const res = fuzzyFind(file, "c\nd\ne\n", target, splitKeepNewline("X\nY\nZ\n"));
  assert.equal(res.appliedAt.startLine, 3);
  assert.equal(res.appliedAt.endLine, 5);
  assert.equal(res.similarity, 1);
  assert.equal(res.content, "a\nb\nX\nY\nZ\nf\ng\nh\n");
});

test("fuzzyFind: tolerates small drift below threshold", () => {
  const file = splitKeepNewline("function foo() {\n  return 1;\n}\n");
  const target = splitKeepNewline("function foo() {\n  return 2;\n}\n");
  const res = fuzzyFind(file, "function foo() {\n  return 2;\n}\n", target, splitKeepNewline("function foo() {\n  return 9;\n}\n"));
  assert.ok(res, "expected fuzzy hit above 0.9");
  assert.ok(res.content.includes("return 9"));
});

test("fuzzyFind: rejects when anchors absent", () => {
  const file = splitKeepNewline("x\ny\nz\nw\nv\n");
  const target = splitKeepNewline("thisIsAVeryLongUniqueToken_abc\nline2\nline3\n");
  assert.equal(fuzzyFind(file, target.join(""), target, ["q\n"]), undefined);
});

test("anchorTokens: picks longest distinctive tokens", () => {
  const a = anchorTokens(["x\n", "const veryLongIdentifierName = 1\n"]);
  assert.deepEqual(a, ["veryLongIdentifierName".slice(0, 30)]);
});

test("indentRewrite: median delta re-indent", () => {
  const file = ["    a\n", "    b\n", "    c\n"];
  const target = ["a\n", "b\n", "c\n"];
  const out = indentRewrite(file, target, ["x\n", "y\n"]);
  assert.deepEqual(out, ["    x\n", "    y\n"]);
});

test("textnorm: smart quotes normalize + offset remap", () => {
  const { normalized, replacements } = normalizeText("a “b” — c …");
  assert.equal(normalized, 'a "b" - c ...');
  assert.equal(needsNormalize(normalized), false);
  const back = unmapOffset({ replacements }, normalized.indexOf('"'));
  assert.equal(back, 2);
});

test("expandWildcard: /* ... */ matches block with brace depth", () => {
  const content = "function f() {\n  inner();\n  more();\n}\nnext();\n";
  const res = expandWildcard(content, "function f() {\n/* ... */\n}\n");
  assert.ok(res.includes("inner()"));
});

test("line-range/cell suffix parsing", () => {
  assert.deepEqual(parseLineRangeSuffix("src/a.ts#10-20").lineRange, { startLine: 10, endLine: 20 });
  assert.equal(parseLineRangeSuffix("src/a.ts").path, "src/a.ts");
  assert.deepEqual(parseCellSuffix("n.ipynb#cell=3"), { path: "n.ipynb", cell: { kind: "index", index: 3 }, rawSuffix: "#cell=3" });
  assert.equal(parseCellSuffix("n.ipynb#cell=first").cell.kind, "first");
});

test("expandOmitTags: tag expands to the covered file span", () => {
  const r = expandOmitTags("a KEEP b", "a [⋯] b");
  assert.equal(r.concrete, "a KEEP b");
  assert.deepEqual(r.spans, ["KEEP"]);
  assert.equal(replaceOmitTagOnce("x [⋯] y", "KEEP"), "x KEEP y");
  assert.equal(expandOmitTags("a b", "zzz [⋯] q"), undefined);
});
