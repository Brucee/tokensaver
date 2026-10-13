import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runEdit } from "../src/tools/edit.mjs";

const FIX = join(tmpdir(), "tokensaver-edit-fixture");
mkdirSync(FIX, { recursive: true });

beforeEach(() => {
  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(FIX, { recursive: true });
});
after(() => rmSync(FIX, { recursive: true, force: true }));

const text = (r) => r.content[0].text;
const write = (f, c) => writeFileSync(join(FIX, f), c);
const read = (f) => readFileSync(join(FIX, f), "utf8");
const edit = (e) => runEdit({ edits: [e] }, { cwd: FIX });

test("Edit: single exact match applies with #range", async () => {
  write("a.txt", "one\ntwo\nthree\n");
  const r = await edit({ file_path: "a.txt", old_string: "two", new_string: "TWO" });
  assert.equal(read("a.txt"), "one\nTWO\nthree\n");
  assert.ok(text(r).includes("a.txt#2"));
  assert.ok(text(r).includes("(1 edit, modified)"));
});

test("Edit: ambiguous match errors with candidate ranges", async () => {
  write("a.txt", "x\nx\nx\n");
  const r = await edit({ file_path: "a.txt", old_string: "x", new_string: "y" });
  assert.equal(r.isError, true);
  assert.ok(text(r).includes("ambiguous"));
});

test("Edit: #line-range disambiguates", async () => {
  write("a.txt", "x\nb\nx\n");
  const r = await edit({ file_path: "a.txt#3", old_string: "x", new_string: "y" });
  assert.equal(read("a.txt"), "x\nb\ny\n");
});

test("Edit: replace_all counts occurrences", async () => {
  write("a.txt", "x\nx\nx\n");
  const r = await edit({ file_path: "a.txt", old_string: "x", new_string: "y", replace_all: true });
  assert.equal(read("a.txt"), "y\ny\ny\n");
  assert.ok(text(r).includes("replaced 3 occurrences"));
});

test("Edit: fuzzy match recovers whitespace drift", async () => {
  write("a.txt", "function f() {\n  return 1;\n}\n");
  const r = await edit({
    file_path: "a.txt",
    old_string: "function f() {\n    return 1;\n}\n",
    new_string: "function f() {\n  return 2;\n}\n",
  });
  assert.equal(read("a.txt"), "function f() {\n  return 2;\n}\n");
  assert.ok(text(r).includes("similarity"));
});

test("Edit: smart-quote normalization", async () => {
  write("a.txt", "say “hi” ok\n");
  const r = await edit({ file_path: "a.txt", old_string: 'say "hi" ok', new_string: "done" });
  assert.equal(read("a.txt"), "done\n");
});

test("Edit: create new file", async () => {
  const r = await edit({ file_path: "new.txt", new_string: "hello\n" });
  assert.equal(read("new.txt"), "hello\n");
  assert.ok(text(r).includes("new file"));
});

test("Edit: file not found with old_string", async () => {
  const r = await edit({ file_path: "missing.txt", old_string: "x", new_string: "y" });
  assert.equal(r.isError, true);
  assert.equal(r._meta.errorCode, "EDIT_FILE_NOT_FOUND");
});

test("Edit: protected path refused", async () => {
  const r = await edit({ file_path: "node_modules/x/a.js", old_string: "x", new_string: "y" });
  assert.equal(r._meta.errorCode, "EDIT_PROTECTED_PATH");
});

test("Edit: ipynb shadow guardrail", async () => {
  write("nb.ipynb", '{"cells":[]}');
  const r = await edit({ file_path: "nb.py", new_string: "x=1\n" });
  assert.equal(r._meta.errorCode, "EDIT_PY_SHADOW_GUARDRAIL");
  assert.equal(existsSync(join(FIX, "nb.py")), false);
});

test("Edit: batch across files", async () => {
  write("a.txt", "a1\na2\n");
  write("b.txt", "b1\nb2\n");
  const r = await runEdit({
    edits: [
      { file_path: "a.txt", old_string: "a1", new_string: "A1" },
      { file_path: "b.txt", old_string: "b2", new_string: "B2" },
    ],
  }, { cwd: FIX });
  assert.equal(read("a.txt"), "A1\na2\n");
  assert.equal(read("b.txt"), "b1\nB2\n");
});

test("Edit: batch continues after one fails", async () => {
  write("a.txt", "keep\n");
  const r = await runEdit({
    edits: [
      { file_path: "a.txt", old_string: "nope", new_string: "x" },
      { file_path: "a.txt", old_string: "keep", new_string: "KEPT" },
    ],
  }, { cwd: FIX });
  assert.equal(r.isError, true);
  assert.equal(read("a.txt"), "KEPT\n");
});

test("Edit: ipynb cell text edit", async () => {
  write("n.ipynb", JSON.stringify({ cells: [{ cell_type: "code", id: "c1", source: ["x = 1\n"] }], nbformat: 4 }));
  const r = await edit({ file_path: "n.ipynb#cell=c1", old_string: "x = 1", new_string: "x = 2" });
  const nb = JSON.parse(read("n.ipynb"));
  assert.equal(nb.cells[0].source.join(""), "x = 2\n");
});

test("Edit: ipynb cell delete", async () => {
  write("n.ipynb", JSON.stringify({ cells: [
    { cell_type: "code", id: "a", source: ["1\n"] },
    { cell_type: "markdown", id: "b", source: ["md\n"] },
  ], nbformat: 4 }));
  const r = await edit({ file_path: "n.ipynb#cell=last", cell_action: "delete" });
  const nb = JSON.parse(read("n.ipynb"));
  assert.equal(nb.cells.length, 1);
  assert.equal(nb.cells[0].id, "a");
});

test("Edit: ipynb insert_after + move_before", async () => {
  write("n.ipynb", JSON.stringify({ cells: [
    { cell_type: "code", id: "a", source: ["1\n"] },
    { cell_type: "code", id: "b", source: ["2\n"] },
  ], nbformat: 4 }));
  let r = await edit({ file_path: "n.ipynb#cell=a", cell_action: "insert_after", cell_type: "markdown", new_string: "mid\n" });
  let nb = JSON.parse(read("n.ipynb"));
  assert.equal(nb.cells.length, 3);
  assert.equal(nb.cells[1].cell_type, "markdown");
  r = await edit({ file_path: "n.ipynb#cell=2", cell_action: "move_before", cell_move_target: 0 });
  nb = JSON.parse(read("n.ipynb"));
  assert.equal(nb.cells[0].id, "b");
});

test("Edit: ipynb ambiguous cell id", async () => {
  write("n.ipynb", JSON.stringify({ cells: [
    { cell_type: "code", id: "dup", source: ["1\n"] },
    { cell_type: "code", id: "dup", source: ["2\n"] },
  ], nbformat: 4 }));
  const r = await edit({ file_path: "n.ipynb#cell=dup", cell_action: "delete" });
  assert.equal(r.isError, true);
  assert.ok(text(r).includes("ambiguous"));
});

test("Edit: syntax errors reported advisory", async () => {
  write("bad.js", "function broken( {\n");
  const r = await edit({ file_path: "bad.js", old_string: "function broken( {", new_string: "function broken( {\n  syntax error here!!!\n" });
  assert.ok(text(r).includes("Syntax errors:"));
});
