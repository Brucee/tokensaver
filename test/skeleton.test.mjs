import { test } from "node:test";
import assert from "node:assert/strict";
import { skeletonize } from "../src/lib/skeleton.mjs";

test("python: folds function bodies, keeps signatures + class structure", async () => {
  const src = "import os\n\ndef helper(a, b):\n    x = a + b\n    y = x * 2\n    return y\n\nclass Service:\n    def run(self):\n        for i in range(10):\n            print(i)\n        return True\n";
  const out = await skeletonize("/tmp/x.py", src);
  assert.match(out, /import os/);
  assert.match(out, /def helper\(a, b\):/);
  assert.match(out, /⋮ 3 lines/);
  assert.match(out, /class Service:/);
  assert.match(out, /def run\(self\):/); // nested signature survives
  assert.doesNotMatch(out, /x = a \+ b/);
});

test("php: folds method bodies inside class", async () => {
  const src = "<?php\nclass U {\n    public function find($id) {\n        $a = 1;\n        $b = 2;\n        return $a + $b;\n    }\n}\n";
  const out = await skeletonize("/tmp/x.php", src);
  assert.match(out, /class U \{/);
  assert.match(out, /public function find\(\$id\) \{/);
  assert.match(out, /⋮ 3 lines/);
  assert.doesNotMatch(out, /\$a = 1/);
});

test("rust: folds fn bodies, keeps struct fields visible", async () => {
  const src = "struct C {\n    host: String,\n    port: u16,\n}\n\nfn main() {\n    let a = 1;\n    let b = 2;\n}\n";
  const out = await skeletonize("/tmp/x.rs", src);
  assert.match(out, /host: String/);
  assert.match(out, /port: u16/);
  assert.match(out, /fn main\(\) \{/);
  assert.match(out, /⋮ 2 lines/);
  assert.doesNotMatch(out, /let a = 1/);
});

test("typescript: folds function + method bodies", async () => {
  const src = "export function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
  const out = await skeletonize("/tmp/x.ts", src);
  assert.match(out, /export function f\(\) \{/);
  assert.match(out, /⋮ 3 lines/);
  assert.doesNotMatch(out, /const a = 1/);
});

test("java: folds method bodies, keeps class + signatures", async () => {
  const src = "class A {\n    void f() {\n        int x = 1;\n        int y = 2;\n    }\n    void g() {\n    }\n}\n";
  const out = await skeletonize("/tmp/x.java", src);
  assert.match(out, /class A \{/);
  assert.match(out, /void f\(\) \{/);
  assert.match(out, /void g\(\)/);
  assert.match(out, /⋮ 2 lines/);
});

test("tsx: a component body folds whole even with nested blocks", async () => {
  const src = "import React from 'react';\n\nexport default function Screen() {\n  useEffect(() => {\n    load();\n    track();\n  }, []);\n  if (x) {\n    a();\n    b();\n  }\n  return null;\n}\n";
  const out = await skeletonize("/tmp/x.tsx", src);
  assert.match(out, /import React/);
  assert.match(out, /export default function Screen\(\) \{/);
  assert.match(out, /⋮ 9 lines/);
  assert.doesNotMatch(out, /useEffect|load\(\)/);
});

test("typescript: class methods stay visible, their nested blocks fold", async () => {
  const src = "class S {\n  run() {\n    for (const x of xs) {\n      a(x);\n    }\n    return 1;\n  }\n  stop() {\n    b();\n    c();\n  }\n}\n";
  const out = await skeletonize("/tmp/x.ts", src);
  assert.match(out, /run\(\) \{/);
  assert.match(out, /stop\(\) \{/);
  assert.match(out, /⋮ 4 lines/);
  assert.doesNotMatch(out, /a\(x\)/);
});

test("unknown ext / clean file → null", async () => {
  assert.equal(await skeletonize("/tmp/x.xyz", "anything"), null);
  assert.equal(await skeletonize("/tmp/x.py", "x = 1\n"), null);
});
