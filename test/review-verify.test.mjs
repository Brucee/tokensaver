import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyFindings } from "../src/lib/review-verify.mjs";

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), "ts-verify-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.js"), "l1\nl2\nl3\n");
  return dir;
}

const INPUT = [
  "- **major** `src/a.js:2` (correctness) missing null check — add a guard",
  "- **major** `src/a.js:2` (type-safety) missing null check — add a guard",
  "- **minor** `src/missing.js:5` (correctness) something else — fix it",
  "- **nit** `src/a.js:9999` (comment-hygiene) stale comment — remove it",
  "- **blocker** `src/a.js` (correctness) whole-file issue — rewrite",
  "No findings.",
  "random prose line",
].join("\n");

test("verifies citations, flags bad ones, dedupes", () => {
  const dir = makeDir();
  try {
    const r = verifyFindings(INPUT, { cwd: dir });
    assert.equal(r.summary.total, 5);

    const [f0, f1, f2, f3, f4] = r.findings;
    assert.equal(f0.status, "verified");
    assert.equal(f1.status, "verified");
    assert.equal(f1.duplicateOf, 0, "near-identical finding merges into first");
    assert.equal(f2.status, "unverifiable:file-not-found");
    assert.match(f3.status, /unverifiable:line-out-of-range/);
    assert.equal(f4.status, "verified:file-only");

    assert.equal(r.summary.verified, 3);
    assert.equal(r.summary.unverifiable, 2);
    assert.equal(r.summary.duplicates, 1);
    assert.equal(r.unparsed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty input → empty summary", () => {
  const r = verifyFindings("No findings.\n", { cwd: tmpdir() });
  assert.equal(r.summary.total, 0);
});
