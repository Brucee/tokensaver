import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSearch } from "../src/tools/search.mjs";
import { globToRegex } from "../src/lib/glob.mjs";

const FIX = join(tmpdir(), "tokensaver-search-fixture");
mkdirSync(join(FIX, "src"), { recursive: true });
mkdirSync(join(FIX, "sub"), { recursive: true });
writeFileSync(join(FIX, "src", "a.ts"), "export function alpha() {\n  return 1;\n}\nconst needle = 'hit';\n");
writeFileSync(join(FIX, "src", "b.ts"), "export const beta = needleCheck();\n");
writeFileSync(join(FIX, "sub", "c.txt"), "nothing here\nneedle on line two\n");
writeFileSync(join(FIX, "src", "imp.ts"), "import { alpha } from './a';\n");

const text = (r) => r.content[0].text;

test("glob: **/*.ts matches recursively", () => {
  const re = globToRegex("src/**/*.ts");
  assert.ok(re.test("src/a.ts"));
  assert.ok(re.test("src/deep/x.ts"));
  assert.ok(!re.test("src/a.js"));
});

test("glob: brace expansion", () => {
  const re = globToRegex("**/*.{ts,tsx}");
  assert.ok(re.test("a.ts"));
  assert.ok(re.test("a.tsx"));
  assert.ok(!re.test("a.js"));
});

test("Search: content_regex finds matches with line numbers", async () => {
  const r = await runSearch({ file_glob_patterns: ["src/*.ts"], content_regex: "needle" }, { cwd: FIX });
  const t = text(r);
  assert.ok(t.includes("a.ts"));
  assert.ok(t.includes("4:const needle"));
});

test("Search: file_paths_only lists dirs with trailing slash", async () => {
  const r = await runSearch({ file_glob_patterns: ["*"], output_mode: "file_paths_only" }, { cwd: FIX });
  const t = text(r);
  assert.ok(t.includes("src/"));
});

test("Search: read mode returns numbered content", async () => {
  const r = await runSearch({ file_glob_patterns: ["src/a.ts"] }, { cwd: FIX });
  const t = text(r);
  assert.ok(t.includes('<file path="src/a.ts"'));
  assert.ok(t.includes("1:export function alpha()"));
});

test("Search: #line-range slices read", async () => {
  const r = await runSearch({ file_glob_patterns: ["sub/c.txt#2"] }, { cwd: FIX });
  const t = text(r);
  assert.ok(t.includes("2:needle on line two"));
  assert.ok(!t.includes("1:nothing here"));
});

test("Search: not-found emits hint tag", async () => {
  const r = await runSearch({ file_glob_patterns: ["missing.ts"] }, { cwd: FIX });
  assert.ok(text(r).includes("<not-found"));
});

test("Search: match_count mode", async () => {
  const r = await runSearch({ file_glob_patterns: ["**/*"], content_regex: "needle", output_mode: "file_paths_with_match_count" }, { cwd: FIX });
  const t = text(r);
  assert.ok(t.includes('total-matches="1"'));
});

test("Search: no params → SEARCH_BAD_ARGS", async () => {
  const r = await runSearch({}, { cwd: FIX });
  assert.equal(r.isError, true);
  assert.equal(r._meta.errorCode, "SEARCH_BAD_ARGS");
});

test("Search: importers list appended", async () => {
  const r = await runSearch({ file_glob_patterns: ["src/a.ts"], list_importers: true }, { cwd: FIX });
  const t = text(r);
  assert.ok(t.includes("--- Imported by ---"));
  assert.ok(t.includes("src/imp.ts"));
});

after(() => rmSync(FIX, { recursive: true, force: true }));
