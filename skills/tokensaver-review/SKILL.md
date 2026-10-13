---
name: tokensaver-review
description: "Local multi-lens code review: collects the full change (committed vs base, staged, unstaged, untracked) and fans it out to parallel single-lens review subagents, then mechanically verifies citations and synthesizes one ranked report. Use when the user asks for a code review, a review before committing, or 'review my changes'."
---

# tokenSaver review

A fully local code-review pipeline: diff metadata → proportional lens selection → parallel single-lens reviewers that self-fetch the bundle → mechanical citation verification → dedup → synthesized report. No servers, no knowledge base.

## Step 1 — metadata only (keep your context light)

For CLI examples, resolve the installed plugin root from the skill location if `CLAUDE_PLUGIN_ROOT` is unset. Select the current host explicitly: `claude` for Claude Code, `codex` for Codex. In Bash use `TOKENSAVER_HOST=codex node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" <command>` (substitute `claude` on Claude Code). In PowerShell use `$env:TOKENSAVER_HOST = "codex"` (or `"claude"`), then `node "$env:CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" <command>`. A quoted absolute script path works in either shell. Do not use Bash variable expansion in PowerShell. Use this invocation for every command below; the command arguments stay the same.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" review-diff --meta            # auto-detects base
node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" review-diff --meta --base dev # explicit base
```

You get JSON: `ok`, `baseName`, `files.byCategory`, `suggestedLenses`. Do NOT run plain `review-diff` yourself — the reviewers fetch their own copy; the 60k bundle never enters your context.

- Handle `ok: false` with `cannot spawn git` first: use raw Git via the host shell to find the merge-base, changed files and changed-line count (default base: `origin/HEAD`, else `main`, else `master`). Include committed, staged, unstaged and untracked changes. Select lenses using the rules below, then continue with the raw-Git reviewer fallback.
- Other `ok: false` results, or no changed files → report the reason and stop.
- An empty lens selection (docs/styles/assets only) → report "no code changes to review" and stop.

## Step 2 — fan out one reviewer per suggested lens, in parallel

**On Claude Code:** launch one `tokensaver:review` Task per lens in **a single message**. Each Task prompt is:

```
Lens: <lens name> — <lens text below>
Fetch the diff bundle with: node "<absolute plugin root>/scripts/tokensaver.mjs" review-diff --base <baseName from step 1>
```

**On Codex:** use the available collaboration tools. Inspect their schema and concurrency limit first. Launch one `spawn_agent` per lens within the available slots; wait for that batch, then reuse completed agents with `followup_task` for remaining lenses when slots cannot be released. Collect every lens result before synthesis. If collaboration tools are unavailable, run the selected lenses sequentially on the main agent and disclose that fallback. Example for a runtime supporting these fields:

```
spawn_agent({
  task_name: "review_cross_file_consistency", // convert lens hyphens to underscores
  fork_turns: "none",          // required by runtimes that restrict model overrides with history forks
  model: "gpt-6-luna",          // cheap tier — omit if your catalog rejects it (the error lists valid models)
  reasoning_effort: "high",     // lenses need real reasoning; subagents inherit the session effort otherwise (usually medium)
  message: "You are a single-lens code reviewer in a parallel review pipeline. First read <absolute plugin root>/agents/review.md — it defines your protocol and output format. Your ONLY lens: <lens name> — <lens text below>. Fetch the diff bundle with: node \"<absolute plugin root>/scripts/tokensaver.mjs\" review-diff --base <baseName from step 1> — if it errors with 'cannot spawn git' (Codex's Windows sandbox blocks node child processes), run the raw git commands yourself via exec instead: `git merge-base HEAD <baseName>` to get the merge-base, `git diff <mergeBase>...HEAD -- .` for committed changes, `git diff` for unstaged, `git diff --cached` for staged, `git status --porcelain` for untracked files (read those directly)."
})
```

Lenses (skip those not in `suggestedLenses`, and say which you skipped):

Small code changes (at most 80 added/deleted lines across at most 3 files) use correctness, cross-file-consistency and type-safety. Larger changes use all seven lenses. Agent instructions and skills count as configuration, even when written in Markdown.

- **correctness** — edge cases, off-by-one, null/None/empty handling, error paths that swallow or misreport failures, races and ordering assumptions.
- **cross-file-consistency** — signatures or contracts changed in one file but callers elsewhere still assume the old shape; renames not propagated; config/schema drift.
- **duplication** — logic repeated across the diff (or between diff and codebase) that should live in one place.
- **existing-code-reuse** — the diff reimplements utilities, helpers, or patterns that already exist in the codebase.
- **type-safety** — loose types introduced (`any`, unchecked casts, implicit `mixed`), narrowing gaps, runtime/type mismatches.
- **sdk-and-schema-reuse** — hand-rolled shapes where the project's SDK, ORM, or schema already defines them.
- **comment-hygiene** — comments that contradict the new code, stale docs, commented-out code, unexplained TODOs.

## Step 3 — mechanical verification (before reading anything)

Concatenate all finding lines from the reviewers into a temp file, then:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" review-verify <tmpfile>
```

The JSON gives each finding a citation `status` (`verified`, `verified:file-only`, or `unverifiable:<reason>`) and `duplicateOf` for possible duplicates at the same location. `verified` only means that the cited file and line exist: it does not validate the bug. Inspect the relevant code before retaining a finding. Merge a duplicate only when it describes the same defect; retain distinct problems at the same line. For invalid citations, check whether the finding can be located in the actual code; otherwise list it as unconfirmed with the reason.

## Step 4 — synthesize (you, on the main model)

1. Rank findings confirmed in code by severity, then file.
2. One wide pass of your own on interactions between findings (e.g. a fix in file A that creates the bug in file B) — you may Read the touched files if a finding's interaction is unclear.
3. Output:

```markdown
## Review — <base> vs current changes

### Blockers / Major
- findings, ordered by severity then file

### Minor / Nits
- findings

### Dropped
- N unverifiable citations (wrong file/line), M duplicates merged

### Coverage
- Lenses run: ... | skipped: ... (reason: no matching file category)

N findings across M files.
```

## Gotchas

- On Claude Code launch the available reviewer Tasks together. On Codex respect the runtime limit, including the parent agent; do not assume excess calls are queued. Batch or reuse reviewers as described above. Use only configuration keys supported by the installed host.
- On Codex, `spawn_agent` rejects unknown `model` slugs with an error that lists the valid catalog — retry with the cheapest tier listed, or omit `model` entirely (the subagent then inherits your model).
- On Codex's Windows sandbox, node cannot spawn child processes inside exec (`EPERM` on any `execFile`/`spawn`) — so `tokensaver.mjs review-diff` fails even though `git` itself works from the shell. The fallback is baked into the prompts above: reviewers run the same `git` commands via exec directly. `review-verify` is pure filesystem and works normally.
- NEVER inline the diff bundle in Task prompts or read it yourself: self-fetch keeps your context free for synthesis. The bundle command is all reviewers need.
- A reviewer returning prose instead of finding lines is a protocol failure — only `- **sev** \`file:line\` (lens) ...` lines reach the verifier; everything else is dropped.
- `unverifiable:line-out-of-range` can mean the reviewer cited the diff hunk line. Locate and inspect the real code before correcting a citation; never guess a line number.
- Base detection needs `origin/HEAD` or a `main`/`master` branch; on a repo with neither, ask the user for `--base`.
- If the bundle printed `[bundle truncated]` (rare, >60k chars), note it in Coverage.
