import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectReviewBundle, formatReviewBundle } from "../src/lib/review-diff.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ts-review-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.js"), "const a = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

test("not a git repo → error", () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-norepo-"));
  const b = collectReviewBundle({ cwd: dir });
  assert.equal(b.ok, false);
  assert.match(formatReviewBundle(b), /not a git repository/);
  rmSync(dir, { recursive: true, force: true });
});

test("committed + staged + unstaged + untracked all appear", () => {
  const dir = makeRepo();
  try {
    // committed change on a feature branch vs main
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(join(dir, "a.js"), "const a = 2;\n");
    git(dir, ["commit", "-am", "change"]);
    // staged change
    writeFileSync(join(dir, "b.js"), "const b = 1;\n");
    git(dir, ["add", "b.js"]);
    // unstaged change
    writeFileSync(join(dir, "a.js"), "const a = 3;\n");
    // untracked file
    writeFileSync(join(dir, "new.js"), "const n = 1;\n");

    const b = collectReviewBundle({ cwd: dir });
    assert.equal(b.ok, true);
    assert.match(b.committed, /const a = 2/);
    assert.match(b.staged, /const b = 1/);
    assert.match(b.unstaged, /const a = 3/);
    assert.equal(b.untracked.length, 1);
    assert.equal(b.untracked[0].path, "new.js");
    assert.match(b.untracked[0].content, /const n = 1/);

    const out = formatReviewBundle(b);
    assert.match(out, /Committed changes vs base/);
    assert.match(out, /Staged \(uncommitted\)/);
    assert.match(out, /Unstaged working-tree changes/);
    assert.match(out, /new\.js/);
    // Small code diffs use the three essential lenses.
    assert.deepEqual([...b.files.all].sort(), ["a.js", "b.js", "new.js"]);
    assert.equal(b.files.byCategory.code.length, 3);
    assert.deepEqual(b.suggestedLenses, ["correctness", "cross-file-consistency", "type-safety"]);
    assert.match(out, /suggested_lenses: correctness/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clean repo reports no changes", () => {
  const dir = makeRepo();
  try {
    const b = collectReviewBundle({ cwd: dir });
    assert.equal(b.ok, true);
    assert.match(formatReviewBundle(b), /No changes to review/);
    assert.deepEqual(b.suggestedLenses, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs-only diff → no suggested lenses", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "README.md"), "# hi\n"); // untracked docs file
    const b = collectReviewBundle({ cwd: dir });
    assert.equal(b.ok, true);
    assert.equal(b.files.byCategory.docs.length, 1);
    assert.deepEqual(b.suggestedLenses, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--base override uses merge-base of that ref", () => {
  const dir = makeRepo();
  try {
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(join(dir, "a.js"), "const a = 9;\n");
    git(dir, ["commit", "-am", "change"]);
    const b = collectReviewBundle({ cwd: dir, base: "main" });
    assert.equal(b.baseName, "main");
    assert.match(b.committed, /const a = 9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
