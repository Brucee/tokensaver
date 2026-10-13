---
description: Update tokenSaver to the latest marketplace release (restart applies it)
allowed-tools: Bash(claude plugin *), Bash(codex plugin *)
---

Update the tokenSaver plugin — pick the block matching the host you are running on.

**On Claude Code** run:

```bash
claude plugin marketplace update tokensaver-marketplace && claude plugin update tokensaver@tokensaver-marketplace -y
```

**On Codex CLI with Bash** run:

```bash
codex plugin marketplace upgrade tokensaver-marketplace && codex plugin add tokensaver@tokensaver-marketplace
```

**On Codex CLI with PowerShell** run (also compatible with Windows PowerShell 5.1):

```powershell
codex plugin marketplace upgrade tokensaver-marketplace
if ($LASTEXITCODE -eq 0) { codex plugin add tokensaver@tokensaver-marketplace }
```

If it reports a newer version was installed, tell the user the update applies on the next session restart (and that on Codex the plugin hooks must be trusted again in `/hooks` if `hooks.json` changed). If it reports "already up to date" or the same version, say so plainly.
