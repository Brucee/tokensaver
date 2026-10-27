---
name: tokensaver-savings
description: "How tokenSaver measures savings — the equivalent-calls model, pricing table, persisted state files, and how to read them. Use when the user asks about the savings numbers, the status line figures, or the state files."
---

# tokenSaver savings

For CLI examples, resolve the installed plugin root from the skill location if `CLAUDE_PLUGIN_ROOT` is unset. Select the current host explicitly: `claude` for Claude Code, `codex` for Codex. In Bash use `TOKENSAVER_HOST=codex node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" <command>` (substitute `claude` on Claude Code). In PowerShell use `$env:TOKENSAVER_HOST = "codex"` (or `"claude"`), then `node "$env:CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" <command>`. A quoted absolute script path works in either shell. Do not use Bash variable expansion in PowerShell. Use this invocation for every command below; the command arguments stay the same.

tokenSaver estimates what its MCP calls would have cost as native tool calls.

## The model

- Every successful `Search`, `Edit` or `Sql` call maps to "equivalent native calls":
  - `Edit` → `max(edits,1) + max(files,1)`
  - `Search` → `2 + extra globs + (regex?1:0) + (summary?1:0)`
  - `Sql` → `5` flat, anything else → `1`
- `callsSaved = max(0, equivalent / 1.29 − actualCalls)` — roundtrips avoided; 1.29 is the measured number of native tool calls the model already packs per turn, so the value can be fractional.
- `timeSaved = callsSaved × 8.8s` (measured mean of a native file-op roundtrip). Session and lifetime time are recomputed from `callsSaved`, so older sessions follow the current constant.
- `tokensSaved = callsSaved × avgTokensPerTurn` (no multiplier).
- Session files also carry `saverCallsByKind` (`Search`/`Edit`/`Sql`/`other`); sessions scanned before the field existed have no breakdown.
- `costSaved` uses the embedded per-model pricing (e.g. sonnet $3/$15, opus $5/$25, haiku $0.8/$4 per million).

## Files

- `~/.claude/tokensaver/sessions/<sessionId>.json` (`~/.codex/tokensaver/sessions/` on Codex) — per-session state: byte offset for incremental scans, usage totals, accumulated savings, daily rollups, compaction counts. On Codex, `subagents.<agentId>` slices track spawn_agent child threads and roll up into the session totals.
- `settings.json` in the same home dir — settings.
- Lifetime stats = rollup over every session file; there is no remote sync.

## Reading it

```bash
tokensaver savings                    # lifetime rollup
tokensaver savings --session <id>     # one session
```

## Gotchas

- Savings only accrue while the transcript file keeps growing; resumed sessions deduplicate via `requestId` so nothing is double-counted.
- A failed tool result does not count as a saved call. If a Codex `exec` wrapper contains several calls and any result reports an error, credit for that wrapper is withheld because individual successes cannot be reliably attributed.
- Codex input tokens include cache reads/writes; those are separated before applying prices. Existing recorded estimates retain their original calculation; new deltas use the corrected accounting.
