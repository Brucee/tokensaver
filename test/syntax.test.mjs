import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSyntax, isCheckable } from "../src/lib/syntax.mjs";

const CASES = [
  { file: "x.py", broken: "def f(:\n  pass\n", valid: "def f():\n    pass\n" },
  { file: "x.php", broken: "<?php\nfunction f( {\n  echo 1;\n", valid: "<?php\nfunction f() {\n  echo 1;\n}\n" },
  { file: "x.rs", broken: "fn main( {\n  let x = 1;\n", valid: "fn main() {\n  let x = 1;\n}\n" },
  { file: "x.java", broken: "class A {\n  void f( {\n  }\n}", valid: "class A {\n  void f() {\n  }\n}\n" },
  { file: "x.ts", broken: "const x: number = ;\n", valid: "const x: number = 1;\n" },
  { file: "x.tsx", broken: "export default () => <div\n", valid: "export default () => <div/>\n" },
  { file: "x.go", broken: "package main\nfunc main( {\n}\n", valid: "package main\nfunc main() {\n}\n" },
  { file: "x.cpp", broken: "int main( {\n  return 0;\n", valid: "int main() {\n  return 0;\n}\n" },
];

test("tree-sitter catches syntax errors per language", async () => {
  for (const c of CASES) {
    assert.equal(isCheckable(c.file), true, `${c.file} checkable`);
    const problems = await checkSyntax("/tmp/" + c.file, c.broken);
    assert.ok(problems.length > 0, `${c.file}: broken input should produce problems`);
    assert.ok(problems[0].line >= 1, `${c.file}: has a line number`);
  }
});

test("tree-sitter returns clean for valid files", async () => {
  for (const c of CASES) {
    const problems = await checkSyntax("/tmp/" + c.file, c.valid);
    assert.deepEqual(problems, [], `${c.file}: valid input should be clean`);
  }
});

test("js still goes through node --check", async () => {
  const problems = await checkSyntax("/tmp/x.mjs", "const x = ;\n");
  assert.ok(problems.length > 0);
});

test("unknown extensions are not checked", () => {
  assert.equal(isCheckable("/tmp/x.xyz"), false);
});
