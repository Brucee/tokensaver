# tokenSaver

Current release: **1.0.7**.

A Claude Code **and Codex CLI** plugin that compresses tool round-trips — smart file search, batch editing with fuzzy matching, and SQL introspection in single MCP calls — and accounts for the calls it saves (status line on Claude Code, `tokensaver savings` on Codex).

**Fully local.** No account, no login, no telemetry, no subscription. Everything the plugin does runs on your machine and works offline.

> Built as a clean-room reimplementation: every behavior is reproduced from a functional specification, the code is readable JavaScript, and there is no bundled or obfuscated code.

## Install

### Claude Code

Inside a Claude Code session:

```
/plugin marketplace add Brucee/tokensaver
/plugin install tokensaver@tokensaver-marketplace
```

### Codex CLI

From a terminal:

```bash
codex plugin marketplace add Brucee/tokensaver
codex plugin add tokensaver@tokensaver-marketplace
```

On first use Codex asks you to review the plugin's hooks — open `/hooks` and trust them once (they are re-verified whenever `hooks.json` changes).

On first load the MCP server installs its npm dependencies once (network needed for ~30s), then everything is cached and works offline.

### What differs on Codex

Same tools, same savings accounting — Codex state lives under `~/.codex/tokensaver/` and transcripts are read from `~/.codex/sessions/` rollouts. Tool redirect, savings, recall, post-compaction recovery and the multi-lens review (via `spawn_agent` instead of `Task`) all work. There is **no status line** — Codex has its own TUI and no statusline hook surface — and the `tokensaver:*` agent files are Claude-only, so the `Task(Explore)` rewrite does not apply.

The review selects up to 7 lenses. On Codex it respects the concurrency limit reported by the available collaboration tools, counting the parent agent too. It launches batches or reuses completed reviewers for the remaining lenses.

## What you get

### MCP tools (server `code`)

| Tool | What it does |
|---|---|
| `Search` | File glob + content regex + per-file context + TS/JS symbol summary + importer graph + image peek — in one call, with an output cap and `if_modified_since` delta mode |
| `Edit` | `cwd` + `edits[]` batch across files: exact → fuzzy (normalized-Unicode Levenshtein, 0.90 threshold, ±10% window, 2s budget) → `replace_all`; `#line-range`, `#cell=` ipynb addressing with `cell_action` (insert/delete/move), protected paths, syntax validation |
| `Sql` | postgres / mysql / sqlite / duckdb: schema introspection, auto-LIMIT, SQL auto-fixer, `table`/`csv`/`json` output, host-scoped connection policy |

### Agents (Claude Code only)

- `tokensaver:code` — the workhorse coding agent wired to the three tools.
- `tokensaver:explore` — Haiku-powered read-only lookups (Search only, ≤5 calls, compact `Defs`/`Refs`/`Callers` output).
- `tokensaver:recall` — finds past answers in your session history via the recall CLI.

### Hooks

- `SessionStart` — primes session state; on Claude Code, registers the status line.
- `UserPromptSubmit` — updates savings accounting; on Claude Code, derives the session title.
- `PreToolUse` — injects `cwd` into plugin tool calls; suggests `Search`/`Edit`/`Sql` when a Bash command re-implements them (`cat`/`grep`/`find`/`ls`/`sed -i`/`psql`/`mysql`/`sqlite3`…); on Claude Code, redirects `Task(Explore)` to the Haiku agent. On Windows Codex, PowerShell file operations and `apply_patch` receive the corresponding MCP hints.
- `StopFailure` — safe no-op logging.

All hooks read the hook envelope on stdin, answer JSON on stdout, never throw, and always exit 0.

### Savings

Every successful MCP call is mapped to the native calls it replaced (`Edit` batch of 10 edits on 3 files → 13.5 calls). The engine parses your transcript JSONL incrementally (byte-offset scanning, `requestId` dedup, failed results don't count) and rolls up session + daily + lifetime stats under `~/.claude/tokensaver/` (`~/.codex/tokensaver/` on Codex, parsed from `rollout-*.jsonl` — subagent usage is tracked per-agent and merged). On Claude Code the status line rotates the numbers; on Codex use `tokensaver savings`. Codex input accounting separates ordinary input, cache reads and cache writes. If a multi-call `exec` wrapper reports an error, the wrapper earns no savings credit because individual successful calls cannot be reliably identified. Previously recorded cost estimates keep their original calculation.

### Recall

```bash
# Claude Code
TOKENSAVER_HOST=claude node "$CLAUDE_PLUGIN_ROOT/scripts/recall.cjs" '<query>' --sessions project
# Codex
TOKENSAVER_HOST=codex node "$CLAUDE_PLUGIN_ROOT/scripts/recall.cjs" '<query>' --sessions project
```

In PowerShell:

```powershell
$env:TOKENSAVER_HOST = "codex" # use "claude" for Claude Code
node "$env:CLAUDE_PLUGIN_ROOT/scripts/recall.cjs" '<query>' --sessions project
```

If `CLAUDE_PLUGIN_ROOT` is unset, use the quoted absolute path to the installed plugin's script.

Turn-level search over past Claude/Codex/Copilot transcripts: BM25F ranking, `--sessions this|project|all`, `--since/--until/--since-last-compactions`, `--show titles`, `--id <sessionId:turnId>` drill-down, scoped guidance on what to do when nothing (or something) matches. Output is JSON sized to `BASH_MAX_OUTPUT_LENGTH`.

## Multi-lens code review

Trigger the review skill with "review my changes" or "review before push". `tokensaver review-diff` prints the diff bundle for manual inspection; it does not launch reviewers. The pipeline is fully local:

1. **Metadata first** — `review-diff --meta` returns a small JSON (merge-base, files by category, `suggestedLenses`) without loading the diff itself.
2. **Proportional fan-out** — small code diffs (at most 80 changed lines across 3 files) get three lenses; larger code diffs get seven; config/agent files get two; docs/assets-only diffs stop early. Claude Code uses `tokensaver:review` agents; Codex uses available collaboration tools within their concurrency limit, or runs lenses sequentially if those tools are unavailable.
3. **Self-fetch + verify** — each reviewer runs `tokensaver review-diff` itself, so the ~60k bundle never enters the main context. It then checks its hypotheses against the real code with read-only tools (`Read`/`Search` on Claude Code, MCP `Search` on Codex); reviewers leave files unchanged and report one line per finding: `- **severity** file:line (lens) problem — fix`, or `No findings.`
4. **Mechanical verification** — `review-verify` checks file/line locations and flags potential duplicates at the same location. The synthesizer verifies each defect in code and decides whether findings describe the same issue.
5. **Synthesis on the main model** — findings ranked by severity, plus one wide pass for cross-finding interactions a single lens can't see (e.g. a fix in file A that creates the bug in file B).

The seven lenses:

| Lens | Looks for |
|---|---|
| `correctness` | edge cases, off-by-one, null/empty handling, swallowed or misreported errors, races |
| `cross-file-consistency` | changed signatures/contracts whose callers still assume the old shape, unpropagated renames, config/schema drift |
| `duplication` | logic repeated inside the diff or between diff and codebase |
| `existing-code-reuse` | reimplemented utilities/helpers/patterns that already exist |
| `type-safety` | loose types (`any`, unchecked casts, implicit `mixed`), narrowing gaps |
| `sdk-and-schema-reuse` | hand-rolled shapes where the project's SDK/ORM/schema defines them |
| `comment-hygiene` | comments contradicting the new code, stale docs, commented-out code, unexplained TODOs |

Claude Code reviewers use Haiku. Codex reviewers use a supported inexpensive model when the runtime allows model selection. Synthesis stays on the main agent.

## Post-compaction recovery

When Claude Code auto-compacts a long session, the summary can drop turns the
work still depends on. The plugin recovers them:

- `PreCompact` writes a marker file at
  `~/.claude/tokensaver/post-compaction-digest/<sessionId>.json`
  (TTL 15 minutes — a stale marker can't fire a digest).
- `PostCompact` (or `SessionStart` with `source: compact`) reads the transcript,
  finds the turns the compaction dropped — present before the newest
  `compact_boundary`, absent from `preservedMessages` — and ranks them by BM25
  against the summary's "where the work was heading" section.
- Category boosts: unresolved errors ×1.5, decisions with reasoning ×1.3,
  TODOs/next-steps ×1.2; content already retained is discounted ×0.6.
- Up to 5 pointer bullets (≤900 chars total) are injected as `additionalContext`;
  the model can expand any of them with `recall --id <session>:<turn>`.

On Codex, recovery reads `compacted.replacement_history` from rollout transcripts and supplies turn IDs that the recall CLI can expand. State and markers live under the Codex plugin home.

The result: after a compaction the model sees *why* decisions were made and what
was left unresolved, instead of reconstructing it by re-reading files.

## How it saves tokens

The plugin doesn't compress prompts — it **reduces the number of round-trips and the size of what enters the context**. Concrete techniques:

| Technique | Where | What it does |
|---|---|---|
| Call fusion | `Search`, `Edit`, `Sql` | One MCP call replaces several native calls: glob+regex+per-file context+symbol summary+importer graph in a single `Search`; multi-file `Edit` batches; schema introspection + auto-LIMIT queries instead of `mysql`/`psql` CLI sessions |
| Dense output | all tools | Row caps, char budgets, `if_modified_since` delta mode — output is sized to fit, never a raw dump |
| AST skeletons | `Search` `summary: true` | Tree-sitter folds function bodies across 10 languages (js/ts/py/java/rs/php/go/c/cpp): signatures, imports and comments stay, bodies collapse to `⋮ N lines` — 45–70% smaller file views |
| Subagent isolation | `tokensaver:explore`, `tokensaver:recall`, reviewers | Verbose work (searches, reads, transcripts) happens in separate reviewer contexts (Haiku on Claude Code, a supported model on Codex); compact results return to the main session |
| Tool redirection | `PreToolUse` hook | Suggests `Search`/`Edit`/`Sql` when a Bash command would re-implement them (`cat`, `grep`, `find`, `sed -i`, `mysql`…) |
| Self-fetching reviewers | `tokensaver-review` | The ~60k diff bundle is fetched by each reviewer subagent itself — it never enters your main context; you only see the synthesized findings |
| Proportional lens selection | `tokensaver-review` | Code diffs of at most 80 changed lines across 3 files use 3 reviewers; larger code diffs use 7. Agent instructions and skills receive configuration review |
| Mechanical verification | `review-verify` | Validates citation locations and suggests duplicates at the same location; the synthesizer checks the actual defect before retaining or merging findings |
| Repo conventions prefetch | `review-diff` | CLAUDE.md/AGENTS.md/glob-scoped rules are bundled deterministically — context-specific findings with zero extra LLM calls |
| Post-compaction digest | `SessionStart` hook | After a compaction, a small digest re-injects unresolved errors, decisions and TODOs — the model doesn't re-read files to reconstruct state |
| Syntax validation on Edit | `Edit` | Tree-sitter/`node --check` catches broken syntax immediately — avoids whole retry turns |
| Cache-friendly ordering | all hooks | Context is injected at the tail (`additionalContext`), preserving the prompt-cache prefix |

### Search limits and settings

- `type` filters the supplied paths/globs; `file_limit` applies after content matching.
- Path-only discovery does not read file bodies or attach images. Broad traversal skips `.git`, `.svn`, `.hg`, `node_modules`, `.venv` and `__pycache__`; explicit paths or globs rooted inside these directories remain available.
- Broad scans and directory listings respect project `.gitignore` files, including nested rules and negations. Use `include_ignored: true` to bypass these rules; literal file paths are always readable. When `cwd` is inside a Git repository, ancestor rules up to its root also apply. Global Git excludes and tracked-file exceptions are not consulted.
- `list_importers` caches parsed TS/JS imports and reuses unchanged graphs. Every call checks the file inventory and metadata (size, modification/change time and inode), reloads ignore rules and resolves import targets again. The cache retains at most 4 project roots, 2,000 source files and 16 MiB of source-equivalent data per root; larger projects still return complete results. Import detection covers relative imports/re-exports and literal `require`/dynamic imports; it is heuristic and does not resolve TypeScript aliases.
- Reads are limited to 4 MiB per file; images to 4 attachments and 8 MiB combined per call. A content regexp has a 1-second execution limit per file. Errors and truncated output are reported; narrow the query to retrieve omitted material.
- Text and path lists share the configured output budget. Content search stops reading more files when its output budget is exhausted.
- Reuse `if_modified_since` only when the previous response covered the requested content. Do not use it to retrieve previously truncated or unread sections.
- `enabled: false` disables the MCP tools and session/status-line hooks. Syntax validation uses global settings, then project overrides, then environment overrides.
- Tool preloading is controlled by `.mcp.json`; the ineffective runtime `alwaysLoadTools` setting is no longer accepted.

### SQL execution limits

- `timeout_ms` is a positive integer (default 30,000), applied per statement including timeout setup. Requests sharing a connection run sequentially; waiting in that queue is outside the statement budget. Connection establishment has a separate timeout.
- SQLite runs in a persistent child process, so CPU-heavy queries can be terminated without blocking the MCP server. A deadline discards the connection and rolls back open transactions; reconnect explicitly afterwards. An in-memory database is lost on disconnect.
- PostgreSQL uses `statement_timeout`; MySQL uses `MAX_EXECUTION_TIME` where supported, with MariaDB's `max_statement_time` fallback. A client deadline also closes stalled connections. Disconnecting cannot guarantee that a remote write stopped before committing: check the database before retrying. No write is retried automatically on timeout.
- DuckDB runs its CLI in [safe mode](https://duckdb.org/docs/current/clients/cli/safe_mode), with configuration locked, extension autoload/install disabled, no spill directory, a 256 MiB memory limit and 2 threads. Main-database SQL remains available; external file reads/writes, network access, external extension loading and `ATTACH` are blocked by the engine. Dot-commands are rejected. This is an engine restriction, not an OS sandbox.
- DuckDB's main database must be inside `cwd` or `tokensaver.sql.duckdb.allowedDirectories` in the active host's SQL policy (`tokensaver.sql` in Claude settings or Codex `<plugin home>/host-settings.json`). These directories do **not** enable external file access. The old `fileWrites: true` option now fails explicitly; remove it or set it to `false`. DuckDB uses a fresh CLI process per request, so use a database file for state shared across calls. Processes are killed on timeout. Unsupported CLI security settings fail closed; the functional tests use DuckDB 1.5.6.

**Honest accounting:** the status line's `callsSaved` is measured (each MCP call maps to the native calls it replaced). `tokensSaved`, `$` and time are *estimates* — calls saved × your session's average turn size, × a fixed per-call time. Treat them as a trend indicator, not an invoice.

## Local installation (Claude Code)

From a marketplace checkout or a local path:

```bash
/plugin marketplace add <this-repo>
/plugin install tokensaver
```

Requires Node **≥ 22.16.0** — the launcher finds a compatible Node automatically (env `TOKENSAVER_NODE`, local cache, version managers) and re-execs if the ambient `node` is too old.

## Update

Inside a Claude Code session:

```
/tokensaver:update
```

or from a terminal:

```bash
claude plugin marketplace update tokensaver-marketplace && claude plugin update tokensaver@tokensaver-marketplace -y
# Codex:
codex plugin marketplace upgrade tokensaver-marketplace && codex plugin add tokensaver@tokensaver-marketplace
```

For Windows PowerShell, update Codex with:

```powershell
codex plugin marketplace upgrade tokensaver-marketplace
if ($LASTEXITCODE -eq 0) { codex plugin add tokensaver@tokensaver-marketplace }
```

The new version takes effect on the next session restart. If Codex hook definitions changed, trust them again in `/hooks`. The plugin checks GitHub once a day at session start and reports newer versions. Disable that notification with `tokensaver settings --set updateCheck false`, selecting the host as described below.

## CLI

```bash
tokensaver status                  # plugin status + lifetime savings
tokensaver savings [--session id]  # savings stats
tokensaver settings --show         # current settings
tokensaver settings --set <key> <true|false>
tokensaver recall '<query>'        # session-history search
tokensaver doctor                  # verify the install
```

Select the CLI host explicitly: in Bash use `TOKENSAVER_HOST=codex tokensaver savings`; in PowerShell use `$env:TOKENSAVER_HOST = "codex"; tokensaver savings`. Use `claude` for Claude Code. `CODEX_HOME` relocates the Codex configuration root; `TOKENSAVER_HOME` overrides plugin state and the Codex SQL-policy file. Claude SQL policy remains in `CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`).

### Router (optional)

A loopback daemon can put other providers behind Claude Code's Anthropic API:
it binds `127.0.0.1`, maps `/router-preset/<preset>` to a provider, translates
the wire protocol (Anthropic Messages ↔ OpenAI chat-completions/responses)
and streams the reply back in Anthropic shape.

```bash
node scripts/tokensaver.mjs router activate /claudecode-openai   # needs OPENAI_API_KEY
node scripts/tokensaver.mjs router status
node scripts/tokensaver.mjs router deactivate                    # restores your previous setup
```

Presets/providers/models are declared in `router-config.jsonc` (bundled) and
`~/.claude/tokensaver/router-config.jsonc` (user overrides, merged by id/path).
`activate` writes `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`,
backing up any previous value; the loopback-only guard refuses to route when
the variable points at a public host. If a session starts while routed and
the daemon is down, the SessionStart hook respawns it. Providers needing
special auth (ChatGPT OAuth, AWS Sig4) are not implemented.

## Configuration

| Where | What |
|---|---|
| `<plugin home>/settings.json` | persisted booleans; default home is `~/.claude/tokensaver/` on Claude Code and `~/.codex/tokensaver/` on Codex |
| Claude `CLAUDE_CONFIG_DIR/settings.json` or Codex `<plugin home>/host-settings.json` | SQL policy under `tokensaver.sql` |
| `TOKENSAVER_HOST=claude` or `codex` | select the CLI host explicitly |
| `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | override the host configuration root |
| `.tokensaver.json` (project) | feature flags + `protectedPaths` |
| `TOKENSAVER_FEATURE_<FLAG>` | env override per flag |
| `TOKENSAVER_HOME` | relocate plugin state and the Codex SQL-policy file |
| `TOKENSAVER_NODE` | pin the Node runtime for scripts |

## Development

```bash
npm test                  # isolated node --test suite, including MCP integration
node scripts/tokensaver.mjs doctor
```

DuckDB integration tests run when `TEST_DUCKDB_BIN` points to an official CLI executable; otherwise they are reported as skipped. For example, in PowerShell: `$env:TEST_DUCKDB_BIN = 'C:\tools\duckdb.exe'; npm test`. Fixtures and settings are isolated in temporary directories. PostgreSQL/MySQL deadline behavior uses test doubles; the suite does not connect to real remote databases.

Layout: `servers/` MCP server, `src/tools/` tool implementations, `src/lib/` shared libs, `src/hooks/` hook dispatchers, `src/cli/` CLI engines, `scripts/` entry stubs + node-launcher, `agents/` + `skills/` + `hooks/` Claude wiring.

## Bug reports

[Open an issue](https://github.com/Brucee/tokensaver/issues) with your host and version (`claude --version` or `codex --version`), plugin version (`tokensaver status` with the correct host), OS, what you ran, and the relevant log/transcript snippet with secrets removed. For MCP failures also attach `tokensaver doctor` output.

## License

MIT
