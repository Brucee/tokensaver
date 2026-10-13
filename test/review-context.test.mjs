import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectRepoContext } from "../src/lib/review-context.mjs";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ts-ctx-"));
  writeFileSync(join(dir, "CLAUDE.md"), "Always use zebra database for queries.");
  mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
  writeFileSync(
    join(dir, ".cursor", "rules", "api.mdc"),
    "---\nglobs: [\"src/api/**\"]\n---\nAll API endpoints must validate input with zod.\n",
  );
  writeFileSync(
    join(dir, ".cursor", "rules", "global.mdc"),
    "---\nalwaysApply: true\n---\nNever commit secrets.\n",
  );
  writeFileSync(join(dir, "eslint.config.mjs"), "export default [];\n");
  return dir;
}

test("always-on + alwaysApply + glob-matched rules", () => {
  const dir = setup();
  try {
    const ctx = collectRepoContext({ cwd: dir, files: ["src/api/users.ts"] });
    const paths = ctx.alwaysOn.map((r) => r.path);
    assert.ok(paths.includes("CLAUDE.md"));
    assert.ok(paths.some((p) => p.endsWith("global.mdc")), "alwaysApply rule promoted");
    assert.equal(ctx.scoped.length, 1);
    assert.match(ctx.scoped[0].body, /zod/);
    assert.deepEqual(ctx.scoped[0].matchedFiles, ["src/api/users.ts"]);
    assert.ok(ctx.tooling.includes("eslint"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-matching glob → scoped rule excluded", () => {
  const dir = setup();
  try {
    const ctx = collectRepoContext({ cwd: dir, files: ["src/ui/button.tsx"] });
    assert.equal(ctx.scoped.length, 0);
    // always-on still present
    assert.ok(ctx.alwaysOn.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty repo → empty context", () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-ctx-empty-"));
  try {
    const ctx = collectRepoContext({ cwd: dir, files: ["a.js"] });
    assert.deepEqual(ctx, { alwaysOn: [], scoped: [], tooling: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
