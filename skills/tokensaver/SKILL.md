---
name: tokensaver
description: "What the tokenSaver plugin does, its tools, commands and configuration. Use when the user asks about tokenSaver itself, its features, or how to control it."
---

# tokenSaver

tokenSaver is a Claude Code and Codex plugin that compresses tool round-trips (Search, Edit, Sql), tracks the tool calls it saves, and shows the savings in the status line (Claude only). It is fully local — no account, no telemetry, no subscription.

## Tools (MCP server `code`)

The three tools are `Search`, `Edit`, `Sql` — on Claude Code they are exposed as `mcp__plugin_tokensaver_code__*`, on Codex as `mcp__code__*`.

- `Search` — file discovery + content match + TS/JS summary + importer graph in one call.
- `Edit` — batch multi-file edits with fuzzy matching, `#line-range` and `#cell=` addressing, syntax validation and protected paths.
- `Sql` — read queries against postgres/mysql/sqlite/duckdb with schema introspection and auto-LIMIT.

## Commands

```bash
tokensaver status            # plugin status + lifetime savings
tokensaver savings           # savings stats (--session <id> for one session)
tokensaver settings --show   # current settings
tokensaver settings --set <key> <true|false>   # toggle a setting (sql: JSON policy)
tokensaver recall '<query>'  # search past session transcripts
tokensaver doctor            # verify the install
```

## Configuration

- `<home>/settings.json` — persisted settings (booleans); home is `~/.claude/tokensaver/` on Claude, `~/.codex/tokensaver/` on Codex.
- `.tokensaver.json` in a project — feature flags (`systemPromptReorder`, `protectedFiles`, `betterErrors`, `syntaxValidation`, `toolRedirect`) and `protectedPaths`.
- `TOKENSAVER_FEATURE_<FLAG>=1|true` — env override per flag.
- `TOKENSAVER_HOME` — relocates the data dir.

## Gotchas

- The Sql `sql` policy lives in the host settings file under `tokensaver.sql` (`~/.claude/settings.json` on Claude, `~/.codex/tokensaver/host-settings.json` on Codex); clear it with `tokensaver settings --set sql none`.
- `alwaysLoadTools` and `statusLine` take effect on the next session.
