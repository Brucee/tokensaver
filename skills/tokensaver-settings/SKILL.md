---
name: tokensaver-settings
description: "Change tokenSaver settings — enable/disable the plugin features, the status line, hook behavior. Use when the user asks to turn something on/off, change plugin behavior, or asks what settings exist."
---

# tokenSaver settings

For CLI examples, resolve the installed plugin root from the skill location if `CLAUDE_PLUGIN_ROOT` is unset. Select the current host explicitly: `claude` for Claude Code, `codex` for Codex. In Bash use `TOKENSAVER_HOST=codex node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" <command>` (substitute `claude` on Claude Code). In PowerShell use `$env:TOKENSAVER_HOST = "codex"` (or `"claude"`), then `node "$env:CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" <command>`. A quoted absolute script path works in either shell. Do not use Bash variable expansion in PowerShell. Use this invocation for every command below; the command arguments stay the same.

Runtime boolean settings live in `settings.json` under the plugin home (`~/.claude/tokensaver/` on Claude, `~/.codex/tokensaver/` on Codex). Change them through the CLI — never edit the JSON by hand while a session may write it.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" settings --show          # current settings
node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" settings --set <key> <value>
```

Run `--show` for the full list. Main keys:

- `enabled` — master switch for MCP tools, hooks, redirects and savings accounting
- `statusLine` — the two-line status line, **Claude only** (`statusLineSession`, `statusLineLifetime`, `statusLineTips` toggle its parts); saved but inert on Codex
- `postCompactionDigest` — recovered-turns digest after compaction
- `syntaxValidation` — tree-sitter/`node --check` advisory on Edit
- `autoSessionTitle`, `spinnerVerbs`, `defaultAgent` — **Claude only**; saved but inert on Codex
- `updateCheck` — daily update notification
- `sql` — JSON policy in the host settings file under `tokensaver.sql`; Claude uses its shared settings, Codex uses `<plugin home>/host-settings.json`

When the user asks for a behavior with no matching key, say so. The CLI rejects unknown keys and non-boolean values for boolean settings. `attribution` is not a supported CLI setting; tool preloading is configured in `.mcp.json`.

## Gotchas

- Settings read happens per hook invocation, so most changes apply to the **next** event — but the status line itself needs a new session (or `/statusline` refresh) to appear/disappear.
- For boolean settings pass `true`/`false` (words); other values are rejected.
- Disabling `enabled` stops hooks and savings accounting; MCP tools return `TOKENSAVER_DISABLED` until re-enabled through the CLI.
