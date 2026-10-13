import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "scripts", "session-hook.cjs");

function runHook(payload) {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `hook exit ${r.status} stderr: ${r.stderr}`);
  const out = r.stdout.trim();
  return out === "" ? undefined : JSON.parse(out);
}

const base = { session_id: "s1", transcript_path: "t.jsonl", cwd: "C:\\proj" };

test("PreToolUse: cat → Search nudge, never blocks", () => {
  const out = runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat src/app.ts" } });
  const h = out.hookSpecificOutput;
  assert.equal(h.permissionDecision, undefined); // advisory only — never approve on the user's behalf
  assert.match(h.additionalContext, /Search/);
});

test("PreToolUse: sed -i → Edit nudge", () => {
  const out = runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sed -i 's/a/b/' f.txt" } });
  assert.match(out.hookSpecificOutput.additionalContext, /Edit/);
});

test("PreToolUse: sqlite3 → Sql nudge", () => {
  const out = runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sqlite3 db.sqlite 'select 1'" } });
  assert.match(out.hookSpecificOutput.additionalContext, /Sql/);
});

test("PreToolUse: git/npm/build → silent", () => {
  for (const command of ["git status", "npm run build", "npm test", "node server.js"]) {
    assert.equal(runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }), undefined, command);
  }
});

test("PreToolUse: Read/Grep/Edit builtins → nudge to our tools", () => {
  const read = runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" } });
  assert.match(read.hookSpecificOutput.additionalContext, /Search/);
  const write = runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "a.ts" } });
  assert.match(write.hookSpecificOutput.additionalContext, /Edit/);
});

test("PreToolUse: own MCP tool without cwd → cwd injected", () => {
  const out = runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "mcp__plugin_tokensaver_code__Search", tool_input: { file_glob_patterns: ["**/*.ts"] } });
  assert.deepEqual(out.hookSpecificOutput, {
    hookEventName: "PreToolUse",
    updatedInput: { file_glob_patterns: ["**/*.ts"], cwd: "C:\\proj" },
  });
});

test("PreToolUse: own MCP tool with cwd → untouched", () => {
  const out = runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "mcp__plugin_tokensaver_code__Edit", tool_input: { cwd: "D:\\other", edits: [] } });
  assert.equal(out, undefined);
});

test("PreToolUse: Task Explore → rewritten to tokensaver:explore", () => {
  const out = runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { subagent_type: "Explore", prompt: "find X" } });
  assert.equal(out.hookSpecificOutput.updatedInput.subagent_type, "tokensaver:explore");
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
});

test("PreToolUse: Task general-purpose → untouched", () => {
  const out = runHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { subagent_type: "general-purpose" } });
  assert.equal(out, undefined);
});

// ---- codex envelopes (verified live on codex 0.162.1) ----

test("PreToolUse (codex): apply_patch → Edit nudge", () => {
  process.env.TOKENSAVER_HOST = "codex";
  try {
    const out = runHook({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: a.txt\n@@\n-x=1\n+x=2\n*** End Patch" },
    });
    assert.match(out.hookSpecificOutput.additionalContext, /mcp__code__Edit/);
  } finally {
    delete process.env.TOKENSAVER_HOST;
  }
});

test("PreToolUse (codex): PowerShell read reported as Bash → Search nudge", { skip: process.platform !== "win32" }, () => {
  // On Windows codex reports its exec shell as tool_name "Bash" even though
  // the command is PowerShell — the PS pattern set must still match.
  process.env.TOKENSAVER_HOST = "codex";
  try {
    const out = runHook({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "Get-Content -LiteralPath conf.txt" },
    });
    assert.match(out.hookSpecificOutput.additionalContext, /mcp__code__Search/);
  } finally {
    delete process.env.TOKENSAVER_HOST;
  }
});

const TP = join(HERE, ".tmp-transcript.jsonl");
function withTranscript() {
  writeFileSync(
    TP,
    [
      JSON.stringify({ type: "user", message: { content: "please fix the login bug in the auth module" } }),
      JSON.stringify({ type: "assistant", requestId: "r1", message: { model: "m", stop_reason: "end_turn", content: [], usage: {} } }),
    ].join("\n") + "\n"
  );
  return TP;
}

test("UserPromptSubmit: derives short session title", () => {
  const out = runHook({ ...base, hook_event_name: "UserPromptSubmit", transcript_path: withTranscript(), prompt: "please fix the login bug in the auth module" });
  assert.equal(out.hookSpecificOutput.sessionTitle, "Fix the login bug");
  rmSync(TP, { force: true });
});

test("UserPromptSubmit: scrubs secrets and paths from title", () => {
  const tp = withTranscript();
  const out = runHook({ ...base, hook_event_name: "UserPromptSubmit", transcript_path: tp, prompt: "check C:\\very\\long\\path\\to\\the\\config\\file\\settings.json api_key=ghp_abcdefghijklmnop1234 now" });
  const title = out.hookSpecificOutput.sessionTitle;
  assert.ok(!title.includes("ghp_"), title);
  assert.ok(title.length <= 41, title);
  rmSync(TP, { force: true });
});

test("UserPromptSubmit: slash/bang/stopword prompts → silent", () => {
  for (const prompt of ["/help", "!ls", "ok"]) {
    assert.equal(runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt }), undefined, prompt);
  }
});

test("UserPromptSubmit: existing session_title → silent", () => {
  const out = runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix the bug", session_title: "My session" });
  assert.equal(out, undefined);
});

test("SessionStart/StopFailure → exit 0 silent", () => {
  assert.equal(runHook({ ...base, hook_event_name: "SessionStart", source: "startup" }), undefined);
  assert.equal(runHook({ ...base, hook_event_name: "StopFailure", error: { message: "x" } }), undefined);
});

test("malformed stdin → exit 0 silent", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: "not json{", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});
