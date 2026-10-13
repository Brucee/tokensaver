---
name: tokensaver-status
description: "Check tokenSaver's health — version, data dir, settings, lifetime savings, and the doctor self-check for broken installs. Use when the user asks if the plugin is working, reports that hooks/tools/savings stopped, or wants diagnostics."
---

# tokenSaver status & doctor

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" status   # version, data dir, settings, lifetime totals (JSON)
node "$CLAUDE_PLUGIN_ROOT/scripts/tokensaver.mjs" doctor   # self-check: node version, files, registration (JSON, exit 1 on failure)
```

`status` answers "is it configured and how much has it saved". `doctor` answers "is the install intact" — check each `check` entry with `ok: false` in the JSON.

## Gotchas

- `doctor` checks files and registration, not runtime behavior — if hooks pass but savings show zero, look at tool-call rejections in the transcript instead (denied MCP calls don't count).
- `status` output is JSON — read fields, don't grep prose.
- After fixing what `doctor` flags (e.g. missing statusline registration — a Claude-only feature, the check self-skips on Codex), changes apply to new sessions unless the user reloads plugins.
