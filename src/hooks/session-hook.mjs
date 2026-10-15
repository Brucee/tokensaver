// Session hook dispatcher — handles every registered hook event (see
// hooks/hooks.json) from a single process, selected by hook_event_name in
// the stdin JSON envelope. Never throws; exits 0.
import { readHookInput, writeHookOutput } from "../lib/hookio.mjs";
import { loadSettings, loadProjectFlags } from "../lib/config.mjs";
import { updateSessionFromTranscript, loadSessionState, saveSessionState, sessionStatsSummary } from "../lib/savings.mjs";
import { deriveTitle, firstPromptInfo, hasExternalTitle } from "../lib/session-title.mjs";
import { registerStatusLine, unregisterStatusLine, registerDefaultAgent, unregisterDefaultAgent, registerSpinnerVerbs, unregisterSpinnerVerbs } from "../lib/claude-settings.mjs";
import { ensureRouterIfActive } from "../cli/router.mjs";
import { appendFileSync } from "node:fs";
import { markPendingCompaction, buildPostCompactionDigest } from "../lib/compaction-digest.mjs";
import { updateAvailableTip } from "../lib/update-check.mjs";
import { getHost, bindHost } from "../host/index.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Host adapter (claude | codex | …). Capabilities gate every host-specific
// feature — on hosts without them the branches below are simply skipped, so
// the plugin stays inert rather than broken. Resolved from env first, then
// re-resolved against the raw hook input below (Codex-only fields).
let HOST = getHost();

const SEARCH_JOB_TOOLS = new Set(["Read", "Grep", "Glob"]);
// apply_patch is Codex's edit tool (reported verbatim as tool_name); the
// Claude-only names are harmless there and vice versa.
const EDIT_JOB_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "apply_patch"]);

// Our MCP tool names differ per host (server id changes). Derived at call
// time so the adapter resolved from the hook envelope drives them.
function ownTools() {
  const p = HOST.toolNames.mcpPrefix;
  return {
    re: new RegExp(`^${p}(Search|Edit|Sql)$`),
    search: `${p}Search`,
    edit: `${p}Edit`,
    sql: `${p}Sql`,
  };
}
const OWN_AGENT = "tokensaver:explore";
const BUILTIN_EXPLORE = "Explore";

// ---------- tool redirect (PreToolUse) ----------

const RE_BUILD_TEST = /\b(tsc|npm run build|npm run compile|npx tsc|npm( run)? test|node --test|node --import tsx|npx tsx)\b/;
const RE_CAT_SED = /^(cat|sed)\s/;
const RE_HEAD_TAIL = /^(head|tail|less|more)\b/;
const RE_FILE_ARG = /\s(?!-)\S*[./]\S*/;
const RE_GREP = /^(grep|rg|ack|ag|find|awk|bfs|ugrep|ug)\s/;
const RE_LS = /^ls(\s|$)/;
const RE_WRITE = /^(sed\s+-i|cat\s*>|cat\s*\x3c\x3c|echo\s.*>|printf\s.*>)/;
const RE_SQL = /^(psql|pg_dump|pg_restore|mysql|sqlite3)\b/;
const RE_NODE_WRITE = /^node\s+-e\s+[\s\S]*(writeFile|appendFile|createWriteStream)/;
const RE_SAFE = /^(git|docker|kubectl|helm|cargo|go\b|node|bun|deno|python3?|ruby|php|npm|npx|yarn|pnpm|gh|curl|wget|make|cmake|pip3?|pytest|jest|vitest|mocha)\b/;
// PowerShell-native equivalents of the unix patterns above (Windows hosts).
const RE_PS_READ = /^(Get-Content|gc\b|type\b|Select-String|sls\b|findstr|Get-ChildItem|gci\b|dir\b|Get-Item|gi\b)\b/i;
const RE_PS_WRITE = /^(Set-Content|sc\b|Out-File|Add-Content|ac\b|New-Item|ni\b|Copy-Item|Move-Item|Rename-Item|Remove-Item)\b/i;
const RE_KW_OPEN = /^(for|while|until|if|case|select)\b/;
const RE_KW_CLOSE = /^(done|fi|esac)\b/;
const RE_KW_MID = /^(?:then|else|elif|do)\s+/;
const ALLOWED_SUFFIX = "was allowed to run, but you MUST use the correct tool for all subsequent calls.";

// Edit-batching nudge: tracks single-edit Edit calls in a 30s sliding window
// (state file in the OS tmp dir); once the second lands inside the window it
// emits a batching reminder. Mirrors the upstream edit-batching-nudge script.
const EDIT_NUDGE_WINDOW_MS = 30_000;
const EDIT_NUDGE_THRESHOLD = 2;

// Per session: parallel sessions must not count each other's edits.
function editStatePath(sessionId) {
  const id = String(sessionId ?? "default").replace(/[^\w-]/g, "_");
  return join(tmpdir(), `tokensaver-edit-state-${id}.json`);
}

function editBatchingNudge(toolInput, sessionId) {
  const edits = toolInput?.edits;
  if (!Array.isArray(edits) || edits.length !== 1) return undefined;
  const file = edits[0]?.file_path;
  if (typeof file !== "string" || file === "") return undefined;
  const now = Date.now();
  let state = { edits: [] };
  try {
    const parsed = JSON.parse(readFileSync(editStatePath(sessionId), "utf8"));
    if (Array.isArray(parsed?.edits)) state = parsed;
  } catch {}
  state.edits = state.edits.filter((e) => now - e.time < EDIT_NUDGE_WINDOW_MS);
  state.edits.push({ time: now, file });
  try {
    writeFileSync(editStatePath(sessionId), JSON.stringify(state));
  } catch {}
  if (state.edits.length < EDIT_NUDGE_THRESHOLD) return undefined;
  return (
    `You've made ${state.edits.length} individual Edit calls in the last ${EDIT_NUDGE_WINDOW_MS / 1000}s. ` +
    `Consider batching: use edits[] for multiple changes to one file or across files in a single call. ` +
    `This reduces API calls and saves tokens.`
  );
}

function reminderText() {
  const { search, edit } = ownTools();
  return `use ${search} for discovering and loading files and ${edit} for editing files.`;
}

function stripSubshells(cmd) {
  const re = /\$\([^()]*\)|`[^`]*`/g;
  let prev = cmd;
  let next = prev.replace(re, " ");
  while (next !== prev) {
    prev = next;
    next = prev.replace(re, " ");
  }
  return next;
}

function headOfPipeline(cmd) {
  const m = /^([^|;&]+)/.exec(cmd);
  return m ? m[1].trim() : cmd;
}

function splitSegments(cmd) {
  return cmd
    .split(/\s*(?:&&|\|\||;|\n)\s*/)
    .map((seg) => {
      const pipe = seg.indexOf("|");
      return (pipe >= 0 ? seg.substring(0, pipe) : seg).trim();
    })
    .filter(Boolean);
}

function classifyBash(rawCommand, shellName = "Bash", ps = shellName === "PowerShell") {
  const { search: SEARCH_TOOL, edit: EDIT_TOOL, sql: SQL_TOOL } = ownTools();
  const editMsg = `Use the ${EDIT_TOOL} tool for writing and editing files, batched across files in one call, not ${shellName}.`;
  const searchMsg = `Use the ${SEARCH_TOOL} tool for reading files and searching code in one call, not ${shellName}.`;
  const cmd = stripSubshells(rawCommand).trim();
  const segments = splitSegments(cmd);
  if (RE_BUILD_TEST.test(headOfPipeline(cmd))) return undefined;
  if (RE_WRITE.test(cmd) || RE_NODE_WRITE.test(cmd)) return editMsg;
  for (const seg0 of segments) {
    const seg = seg0.replace(RE_KW_MID, "");
    if (RE_NODE_WRITE.test(seg)) return editMsg;
    if (RE_SAFE.test(seg) || RE_KW_OPEN.test(seg) || RE_KW_CLOSE.test(seg)) continue;
    if (RE_WRITE.test(seg)) return editMsg;
    if (ps) {
      if (RE_PS_WRITE.test(seg)) return editMsg;
      if (RE_PS_READ.test(seg)) return searchMsg;
    }
    if (RE_CAT_SED.test(seg) || RE_GREP.test(seg) || RE_LS.test(seg)) return searchMsg;
    const ht = RE_HEAD_TAIL.exec(seg);
    if (ht && RE_FILE_ARG.test(seg.slice(ht[0].length))) return searchMsg;
  }
  if (segments.some((s) => RE_SQL.test(s))) {
    return `Use the ${SQL_TOOL} tool for database queries, not ${shellName}.`;
  }
  return undefined;
}

function classifyBuiltinTool(toolName) {
  const { search: SEARCH_TOOL, edit: EDIT_TOOL } = ownTools();
  if (SEARCH_JOB_TOOLS.has(toolName)) {
    return `Use the ${SEARCH_TOOL} tool for reading files and searching code in one call, not the built-in ${toolName} tool.`;
  }
  if (EDIT_JOB_TOOLS.has(toolName)) {
    return `Use the ${EDIT_TOOL} tool for writing and editing files, batched across files in one call, not the built-in ${toolName} tool.`;
  }
  return undefined;
}

function handlePreToolUse(input) {
  const flags = loadProjectFlags(input.cwd);
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};

  // Our own MCP tools get the session cwd injected when the model omits it.
  const tools = ownTools();
  if (tools.re.test(toolName)) {
    const nudge = toolName === tools.edit ? editBatchingNudge(toolInput, input.session_id) : undefined;
    if (typeof input.cwd === "string" && input.cwd && !(typeof toolInput.cwd === "string" && toolInput.cwd)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { ...toolInput, cwd: input.cwd },
          ...(nudge ? { additionalContext: nudge } : {}),
        },
      };
    }
    if (nudge) {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: nudge } };
    }
    return undefined;
  }

  if (flags.toolRedirect === false) return undefined;

  // Built-in search/edit tools → nudge toward our fused tools.
  const builtin = classifyBuiltinTool(toolName);
  if (builtin) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `IMPORTANT: ${builtin} This tool call ${ALLOWED_SUFFIX} Reminder: ${reminderText()}`,
      },
    };
  }

  // Task/Agent subagent rewrite: Explore → tokensaver:explore (Haiku, our tools).
  // Claude-only: other hosts don't load our agents/*.md so the rewrite target
  // would not exist there.
  if (HOST.capabilities.nativeAgents && (toolName === "Task" || toolName === "Agent") && typeof toolInput.subagent_type === "string") {
    if (toolInput.subagent_type === BUILTIN_EXPLORE) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { ...toolInput, subagent_type: OWN_AGENT },
          additionalContext:
            `Rewrote subagent_type "${BUILTIN_EXPLORE}" → "${OWN_AGENT}". Built-in Explore has no tokenSaver MCP tools and falls back to slow Bash find/grep; ` +
            `${OWN_AGENT} uses ${tools.search}. Use subagent_type "${OWN_AGENT}" directly next time, or call ${tools.search} on the main thread for trivial lookups.`,
        },
      };
    }
    return undefined;
  }

  // Shell classification — Bash on unix, PowerShell on Windows hosts.
  // Codex reports its exec shell as "Bash" even on Windows, where commands are
  // really PowerShell — enable the PS pattern set there too (verified live).
  if ((toolName === "Bash" || toolName === "PowerShell") && typeof toolInput.command === "string") {
    const ps = toolName === "PowerShell" || (HOST.name === "codex" && process.platform === "win32");
    const msg = classifyBash(toolInput.command, toolName, ps);
    if (msg) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `IMPORTANT: ${msg} This command ${ALLOWED_SUFFIX} Reminder: ${reminderText()}`,
        },
      };
    }
  }
  return undefined;
}

// ---------- session title (UserPromptSubmit) ----------

function handleUserPromptSubmit(input) {
  const settings = loadSettings();
  if (!settings.autoSessionTitle) return undefined;
  if (typeof input.session_title === "string" && input.session_title.trim() !== "") return undefined;
  try {
    if (typeof input.transcript_path === "string" && input.transcript_path) {
      const info = firstPromptInfo(input.transcript_path);
      if (!info.hasAssistantTurn || hasExternalTitle(input.transcript_path, info.agentType)) return undefined;
      const title = info.firstPromptTitle ?? deriveTitle(input.prompt ?? "");
      if (!title) return undefined;
      return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title } };
    }
  } catch {
    return undefined;
  }
  const title = deriveTitle(input.prompt ?? "");
  if (!title) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      sessionTitle: title,
    },
  };
}

// ---------- compaction digest (PreCompact / PostCompact) ----------

function handlePreCompact(input) {
  const state = loadSessionState(input.session_id);
  if (!state) return undefined;
  state.compactions ??= {};
  if (input.trigger === "manual") state.compactions.countManual = (state.compactions.countManual ?? 0) + 1;
  else state.compactions.countAuto = (state.compactions.countAuto ?? 0) + 1;
  state.pendingCompactionAt = new Date().toISOString();
  saveSessionState(input.session_id, state);
  markPendingCompaction(input.session_id);
  return undefined;
}

async function handlePostCompact(input) {
  const state = loadSessionState(input.session_id);
  if (!state?.pendingCompactionAt) return undefined;
  const started = Date.parse(state.pendingCompactionAt);
  state.compactions ??= {};
  if (Number.isFinite(started)) {
    state.compactions.timeSpentCompactingInMs =
      (state.compactions.timeSpentCompactingInMs ?? 0) + Math.max(0, Date.now() - started);
  }
  delete state.pendingCompactionAt;
  saveSessionState(input.session_id, state);
  const settings = loadSettings();
  if (!settings.postCompactionDigest) return undefined;

  const parts = [];
  // Smart recovery: ranked pointers to turns the compaction dropped.
  const recovery = await buildPostCompactionDigest(input.session_id, input.transcript_path, HOST.name).catch(() => undefined);
  if (recovery) parts.push(recovery);

  const s = sessionStatsSummary(state);
  const lines = [
    `tokenSaver session digest after compaction:`,
    `- calls saved: ${s.callsSaved} (of ${s.equivalentNativeToolCalls} equivalent native calls)`,
    `- tokens saved: ${s.tokensSaved}, cost saved: $${s.costSavedInUsd.toFixed(4)}`,
  ];
  if (s.codeEditLines) lines.push(`- edited lines: ${s.codeEditLines.linesAdded ?? 0}+ ${s.codeEditLines.linesRemoved ?? 0}-`);
  parts.push(lines.join("\n"));
  return { hookSpecificOutput: { hookEventName: "PostCompact", additionalContext: parts.join("\n\n") } };
}

// ---------- dispatch ----------

const rawInput = await readHookInput();
// Envelope capture for host-adapter work: set TOKENSAVER_HOOK_DUMP=<file> to
// append every raw hook payload (plus the env markers detection sees) as JSONL.
if (process.env.TOKENSAVER_HOOK_DUMP) {
  try {
    appendFileSync(process.env.TOKENSAVER_HOOK_DUMP, JSON.stringify({
      raw: rawInput,
      env: {
        CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT ?? null,
        CODEX_HOME: process.env.CODEX_HOME ?? null,
        CODEX_CLI: process.env.CODEX_CLI ?? null,
      },
      detectedHost: HOST.name,
    }) + "\n");
  } catch {}
}
// Re-resolve with the envelope — Codex-only fields (turn_id, rollout path)
// catch cases the env markers miss.
HOST = bindHost(process.env, rawInput);
const input = HOST.normalizeHookInput(rawInput);
if (loadSettings().enabled === false) process.exit(0);
if (input && typeof input === "object") {
  let out;
  let sessionStartTip;
  try {
    if (input.hook_event_name === "SessionStart") {
      const settings = loadSettings();
      // Host-settings writes (statusline, spinner verbs, default agent) are
      // Claude-specific until the Codex config surface is mapped.
      if (HOST.capabilities.hostSettings) {
        if (settings.statusLine) registerStatusLine(PLUGIN_ROOT);
        else unregisterStatusLine();
        if (settings.spinnerVerbs) registerSpinnerVerbs();
        else unregisterSpinnerVerbs();
        if (settings.defaultAgent) registerDefaultAgent();
        else unregisterDefaultAgent();
      }
      // Sessions starting from a compaction may reach PostCompact without our
      // PreCompact marker — arm the digest from here too (upstream parity).
      if (HOST.capabilities.postCompactDigest && input.source === "compact" && input.session_id) {
        markPendingCompaction(input.session_id);
      }
      // Router recovery: if Claude is routed through our daemon but it died
      // since last session, respawn it so requests don't fail on connect.
      // The spawn itself is detached — if the 3s health probe times out the
      // daemon still finishes booting on its own.
      if (HOST.capabilities.router) {
        await Promise.race([
          ensureRouterIfActive().catch(() => {}),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      }
      // Update check: reads the cached result only (the detached refresh
      // covers the NEXT session) — never blocks startup on the network.
      if (settings.updateCheck !== false) {
        sessionStartTip = updateAvailableTip(PLUGIN_ROOT, { hostName: HOST.name });
      }
    }
    // Incremental savings accounting — cheap no-op when the transcript
    // has not grown since the last scan (byteOffset persisted per session).
    // Transcript format is host-specific: skipped where there's no parser.
    if (HOST.capabilities.transcriptSessions) {
      switch (input.hook_event_name) {
        case "SessionStart":
        case "UserPromptSubmit":
        case "PreToolUse":
        case "PostToolUse":
        case "Stop":
        case "SubagentStop":
          // agent_transcript_path is the subagent's own file at stop time;
          // inside agents transcript_path already points at the agent file.
          // Only trust it when agent_id is set — otherwise an agent file
          // would reset the parent slice's scan state.
          updateSessionFromTranscript(
            input.session_id,
            input.agent_id != null ? input.agent_transcript_path ?? input.transcript_path : input.transcript_path,
            HOST.name,
            input.agent_id
          );
          break;
      }
    }
    switch (input.hook_event_name) {
      case "SessionStart":
        out = sessionStartTip
          ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionStartTip } }
          : undefined;
        break;
      case "PreToolUse":
        out = HOST.capabilities.toolRedirect ? handlePreToolUse(input) : undefined;
        break;
      case "UserPromptSubmit":
        out = HOST.capabilities.sessionTitle ? handleUserPromptSubmit(input) : undefined;
        break;
      case "PreCompact":
        out = HOST.capabilities.postCompactDigest ? handlePreCompact(input) : undefined;
        break;
      case "PostCompact":
        out = HOST.capabilities.postCompactDigest ? await handlePostCompact(input) : undefined;
        break;
      default:
        out = undefined;
    }
  } catch (e) {
    try { process.stderr.write(`[tokensaver:session-hook] ${e?.stack ?? e}\n`); } catch {}
  }
  if (out != null) writeHookOutput(out);
}
process.exit(0);
