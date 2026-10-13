---
name: tokensaver-settings
description: "Change tokenSaver settings — enable/disable the plugin features, the status line, hook behavior. Use when the user asks to turn something on/off, change plugin behavior, or asks what settings exist."
---

# tokenSaver settings

All plugin settings live in `settings.json` under the plugin home (`~/.claude/tokensaver/` on Claude, `~/.codex/tokensaver/` on Codex). Change them through the CLI — never edit the JSON by hand while a session may write it.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" settings --show          # current settings
node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" settings --set <key> <value>
```

Run `--show` for the full list. Main keys:

- `enabled` — master switch for hooks/redirects
- `statusLine` — the two-line status line, **Claude only** (`statusLineSession`, `statusLineLifetime`, `statusLineTips` toggle its parts); saved but inert on Codex
- `postCompactionDigest` — recovered-turns digest after compaction
- `syntaxValidation` — tree-sitter/`node --check` advisory on Edit
- `autoSessionTitle`, `spinnerVerbs`, `attribution` — cosmetic toggles

When the user asks for a behavior with no matching key, say so — do not invent keys; `--set` writes whatever it's given and typos silently do nothing.

## Gotchas

- Settings read happens per hook invocation, so most changes apply to the **next** event — but the status line itself needs a new session (or `/statusline` refresh) to appear/disappear.
- `--set` stores the raw value; pass `true`/`false` (words), not `on`/`off`.
- Disabling `enabled` stops redirects and savings accounting — MCP tools still work, they just are no longer preferred.
