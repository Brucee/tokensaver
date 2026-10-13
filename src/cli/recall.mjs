#!/usr/bin/env node
// tokenSaver recall — search prior Claude/Codex/Copilot session transcripts.
// Clean-room implementation of the recall engine: no index is kept; every run
// streams the in-scope session files, assembles turns, scores them with BM25F
// over {text, toolCall} and emits a JSON envelope sized to the output budget.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectHost as detectPluginHost } from "../host/index.mjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants (behavioral spec)
// ---------------------------------------------------------------------------
const HOSTS = ["claude", "codex", "copilot"];
const SCOPES = ["this", "project", "all"];
const MATCH_FIELDS = ["text", "tool", "result"];
const DEFAULT_MATCH_FIELDS = ["text", "tool"];
const SHOW_MODES = ["full", "titles"];
const DEFAULT_LIMIT = 10;
const NEXT_SCOPE = { this: "project", project: "all" };
const STOP_AT_WIDEST =
  "Widest scope reached — the answer is NOT in session history. Report that plainly and STOP. A negative answer is a valid result; do NOT reword and re-search.";
const FILE_ASK_RE =
  /\b(?:file|path|filepath|scratchpad|draft|wrote|saved|created)\b|\.(?:md|ts|tsx|json|sql)\b/i;
const PREFILTER_MIN_LEN = 3;
const TITLE_MAX_LEN = 100;
const ELLIPSIS = "…";
const BM25F_PARAMS = {
  k1: 1.2,
  fields: { text: { boost: 1, b: 0.75 }, toolCall: { boost: 1, b: 0.75 } },
};
const TOKEN_RE = /[a-z0-9][a-z0-9._/+#_-]*/g;
const COMPOUND_RE = /[._/+#_-]+/;
const REL_AGO_RE = /^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s+ago$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const POS_INT_RE = /^[1-9]\d*$/;
const CODEX_TOOL_TYPES = new Set(["function_call", "local_shell_call", "custom_tool_call"]);
const CLAUDE_NOISE_SNIPPETS = [
  "task-notification",
  "system-reminder",
  "local-command-caveat",
  "NO LOG:",
  "protocolVersion",
];
const GIT_TIMEOUT_MS = 5000;
const SESSION_HEAD_MAX_LINES = 25;
const PREFILTER_CHUNK = 65536;
const CLI_NAME = "tokensaver recall";

// Self-pollution: drops turns that are this tool's own invocations.
const SELF_COMMAND = "/tokensaver:recall";
const SELF_SKILL_PREFIX = "/skills/tokensaver";
const SELF_SLASH_PREFIX = "/tokensaver";
const SELF_TOOLCALL = '"tokensaver:recall"';
const SELF_SUBAGENT = '"subagent_type":"recall"';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
class UsageError extends Error {}

async function* readJsonl(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // skip unparseable lines
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function realNorm(p) {
  const resolved = path.resolve(p);
  try {
    return (await fs.promises.realpath(resolved)).normalize("NFC");
  } catch {
    return resolved.normalize("NFC");
  }
}

function isInsidePath(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function projectSlug(dir) {
  const resolved = path.resolve(dir).normalize("NFC");
  const slug = resolved.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= 200) return slug;
  let h = 0;
  for (let i = 0; i < resolved.length; i++) {
    h = ((h << 5) - h + resolved.charCodeAt(i)) | 0;
  }
  return slug.slice(0, 200) + "-" + Math.abs(h).toString(36);
}

function tokenize(text) {
  const out = [];
  const matches = text.toLowerCase().match(TOKEN_RE);
  if (matches == null) return out;
  for (const tok of matches) {
    out.push(tok);
    if (COMPOUND_RE.test(tok)) {
      for (const part of tok.split(COMPOUND_RE)) {
        if (part.length > 0 && part !== tok) out.push(part);
      }
    }
  }
  return out;
}

function toText(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Documents & turn assembly
// ---------------------------------------------------------------------------
// A "document" is one turn: {key, sessionId, projectPath, timestamp, turnId,
// memberUuids, fields:{text, toolCall, toolResult, thinking}}.

function makeDoc(uuid, timestamp, fields, flags, turnId, extra) {
  return {
    uuid,
    timestamp,
    turnId,
    payload: { fields: { text: "", toolCall: "", toolResult: "", thinking: "", ...fields }, ...extra },
    startsDocument: flags?.startsDocument === true,
    isResponse: flags?.isResponse === true,
  };
}

// Merge payloads into turn fields, dropping tool output shadowed by a failed call.
function mergePayloadFields(payloads) {
  const failedCallIds = new Set();
  for (const p of payloads) {
    if (p.isFailedResult && p.callId != null) failedCallIds.add(p.callId);
  }
  const kept = payloads.filter(
    (p) => !p.isFailedResult && (p.callId == null || !failedCallIds.has(p.callId))
  );
  const fields = { text: "", toolCall: "", toolResult: "", thinking: "" };
  for (const p of kept) {
    const f = p.fields ?? p;
    if (f.text) fields.text += f.text + "\n";
    if (f.toolCall) fields.toolCall += f.toolCall + "\n";
    if (f.toolResult) fields.toolResult += f.toolResult + "\n";
    if (f.thinking) fields.thinking += f.thinking + "\n";
  }
  return fields;
}

// Assemble raw docs into turns. A boundary is a new turnId, or a user document
// (startsDocument) arriving after an assistant response.
async function* assembleTurns(docStream, meta, mergeFields) {
  let pending = [];
  let currentTurnId;
  let sawResponse = false;
  for await (const doc of docStream) {
    const boundary =
      doc.turnId != null
        ? sawResponse && currentTurnId != null && doc.turnId !== currentTurnId
        : doc.startsDocument && sawResponse;
    if (boundary) {
      const turn = buildTurn(pending, meta, mergeFields);
      if (turn != null) yield turn;
      pending = [];
      currentTurnId = undefined;
      sawResponse = false;
    }
    pending.push(doc);
    if (currentTurnId == null && doc.turnId != null) currentTurnId = doc.turnId;
    if (doc.isResponse) sawResponse = true;
  }
  const turn = buildTurn(pending, meta, mergeFields);
  if (turn != null) yield turn;
}

function buildTurn(docs, meta, mergeFields) {
  if (docs.length === 0) return undefined;
  const fields = mergeFields(docs.map((d) => d.payload));
  if ((fields.text + fields.toolCall + fields.toolResult + fields.thinking).trim().length === 0) {
    return undefined;
  }
  const turnId = docs[0].turnId ?? docs[0].uuid;
  return {
    key: meta.sessionId + " " + turnId,
    sessionId: meta.sessionId,
    projectPath: meta.projectPath,
    timestamp: docs[0].timestamp,
    turnId,
    memberUuids: docs.map((d) => d.uuid),
    fields,
  };
}

// ---------------------------------------------------------------------------
// Claude host
// ---------------------------------------------------------------------------
function claudeIsNoiseText(text) {
  if (text.startsWith("{") && text.includes("jsonrpc")) return true;
  return CLAUDE_NOISE_SNIPPETS.some((s) => text.includes(s));
}

function claudeUserHasContent(message) {
  const content = message.content;
  if (typeof content === "string") {
    return content.length > 0 && !(content.startsWith("{") || content.startsWith("[") || claudeIsNoiseText(content));
  }
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (block.type === "text" && block.text.length > 0 && !claudeIsNoiseText(block.text)) return true;
  }
  return false;
}

function claudeAssistantHasContent(message) {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (block.type === "tool_use") return true;
    if (block.type === "text" && block.text.length > 0 && !claudeIsNoiseText(block.text)) return true;
  }
  return false;
}

function claudeCollectFailedIds(message, failedIds) {
  const content = message.content;
  if (typeof content === "string" || !Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === "tool_result" && block.is_error === true) failedIds.add(block.tool_use_id);
  }
}

function claudeFieldsOfMessage(message, failedIds) {
  const content = message.content;
  if (typeof content === "string") {
    return { text: content, toolCall: "", toolResult: "", thinking: "" };
  }
  const text = [];
  const toolCall = [];
  const toolResult = [];
  const thinking = [];
  for (const block of content ?? []) {
    switch (block.type) {
      case "text":
        text.push(block.text);
        break;
      case "thinking":
        thinking.push(block.thinking);
        break;
      case "tool_use":
        if (failedIds?.has(block.id)) break;
        toolCall.push(block.name + " " + JSON.stringify(block.input));
        break;
      case "tool_result": {
        if (block.is_error === true) break;
        const c = block.content;
        if (typeof c === "string") {
          toolResult.push(c);
        } else if (Array.isArray(c)) {
          for (const part of c) {
            if (part.type === "text") toolResult.push(part.text);
          }
        }
        break;
      }
    }
  }
  return {
    text: text.join("\n"),
    toolCall: toolCall.join("\n"),
    toolResult: toolResult.join("\n"),
    thinking: thinking.join("\n"),
  };
}

function mergeClaudePayloads(payloads) {
  const failedIds = new Set();
  for (const p of payloads) claudeCollectFailedIds(p, failedIds);
  const fields = { text: "", toolCall: "", toolResult: "", thinking: "" };
  for (const p of payloads) {
    const f = claudeFieldsOfMessage(p, failedIds);
    if (f.text) fields.text += f.text + "\n";
    if (f.toolCall) fields.toolCall += f.toolCall + "\n";
    if (f.toolResult) fields.toolResult += f.toolResult + "\n";
    if (f.thinking) fields.thinking += f.thinking + "\n";
  }
  return fields;
}

async function* claudeRawDocs(filePath) {
  for await (const event of readJsonl(filePath)) {
    if (event.type !== "user" && event.type !== "assistant") continue;
    if (event.type === "user" && event.isCompactSummary === true) continue;
    yield {
      uuid: event.uuid,
      timestamp: event.timestamp ?? "",
      turnId: undefined,
      payload: event.message,
      startsDocument: event.type === "user" && claudeUserHasContent(event.message),
      isResponse: event.type === "assistant" && claudeAssistantHasContent(event.message),
    };
  }
}

function claudeReadDocuments(filePath, meta) {
  return assembleTurns(claudeRawDocs(filePath), meta, mergeClaudePayloads);
}

async function claudeCompactionBoundariesMs(filePath) {
  const out = [];
  for await (const event of readJsonl(filePath)) {
    if (event.type !== "system" || event.subtype !== "compact_boundary") continue;
    const ms = Date.parse(event.timestamp ?? "");
    if (!Number.isNaN(ms)) out.push(ms);
  }
  return out;
}

function claudeHomeDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

function claudeProjectsDir() {
  return path.join(claudeHomeDir(), "projects");
}

async function listClaudeSessions() {
  const root = claudeProjectsDir();
  const out = [];
  let projectDirs;
  try {
    projectDirs = await fs.promises.readdir(root);
  } catch {
    return out;
  }
  for (const dirName of projectDirs) {
    const dirPath = path.join(root, dirName);
    let st;
    try {
      st = await fs.promises.stat(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let files;
    try {
      files = (await fs.promises.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const filePath = path.join(dirPath, f);
      let fst;
      try {
        fst = await fs.promises.stat(filePath);
      } catch {
        continue;
      }
      out.push({
        sessionId: path.basename(f, ".jsonl"),
        sessionFilePath: filePath,
        projectPath: dirName,
        mtimeMs: fst.mtimeMs,
        sizeBytes: fst.size,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

async function claudeSessionCwdHead(filePath) {
  let seen = 0;
  for await (const event of readJsonl(filePath)) {
    if (typeof event.cwd === "string" && event.cwd !== "") {
      return realNorm(event.cwd);
    }
    if (++seen >= SESSION_HEAD_MAX_LINES) break;
  }
  return undefined;
}

async function findRepoRoot(dir) {
  let cur = dir;
  for (;;) {
    try {
      await fs.promises.stat(path.join(cur, ".git"));
      return cur;
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return dir;
    cur = parent;
  }
}

async function listGitWorktrees(dir) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "worktree", "list", "--porcelain"],
      { cwd: dir, timeout: GIT_TIMEOUT_MS, windowsHide: true }
    );
    const out = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) out.push(await realNorm(line.slice("worktree ".length)));
    }
    return out;
  } catch {
    return [];
  }
}

async function resolveClaudeScope(options) {
  if (options.sessions === "this") {
    if (options.sessionId == null || options.sessionId === "") return [];
    const found = (await listClaudeSessions()).find((s) => s.sessionId === options.sessionId);
    return found ? [found] : [];
  }
  const all = applySessionWindow(await listClaudeSessions(), options);
  if (options.sessions === "all" || options.projectDir == null) return all;

  // project scope: sessions whose recorded cwd lives inside the project dir,
  // any of its git worktrees, or an ancestor up to the repo root.
  const projectDir = await realNorm(options.projectDir);
  const worktrees = await listGitWorktrees(projectDir);
  const repoRoot =
    worktrees.find((wt) => isInsidePath(projectDir, wt)) ?? (await findRepoRoot(projectDir));
  const slugSet = new Set();
  for (let d = projectDir; slugSet.add(projectSlug(d)), d !== repoRoot && path.dirname(d) !== d; d = path.dirname(d));
  for (const wt of worktrees) slugSet.add(projectSlug(wt));

  const candidateProjects = worktrees.includes(repoRoot) ? worktrees : [repoRoot, ...worktrees];
  const slugPrefixes = candidateProjects.map((p) => projectSlug(p) + "-");
  const latestByProject = new Map();
  for (const s of all) {
    if (slugSet.has(s.projectPath) || !slugPrefixes.some((pre) => s.projectPath.startsWith(pre))) {
      continue;
    }
    const cur = latestByProject.get(s.projectPath);
    if (cur == null || s.mtimeMs > cur.mtimeMs) latestByProject.set(s.projectPath, s);
  }
  const insideProjects = new Set();
  for (const [projectPath, s] of latestByProject) {
    const cwd = await claudeSessionCwdHead(s.sessionFilePath);
    if (cwd != null && candidateProjects.some((wt) => isInsidePath(cwd, wt))) {
      insideProjects.add(projectPath);
    }
  }
  return all.filter((s) => slugSet.has(s.projectPath) || insideProjects.has(s.projectPath));
}

// ---------------------------------------------------------------------------
// Codex host (~/.codex/sessions/*/*/*/rollout-*-<threadId>.jsonl)
// ---------------------------------------------------------------------------
const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const CODEX_ID_RE = new RegExp("^" + UUID_RE + "$");
const CODEX_FILE_RE = new RegExp("-(" + UUID_RE + ")\\.jsonl$");

function codexSessionsDir() {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
}

async function walkFiles(root, test) {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) await walk(p, depth - 1);
      } else if (e.isFile() && test(e.name)) {
        out.push(p);
      }
    }
  }
  await walk(root, 5);
  return out;
}

async function listCodexSessions() {
  const files = await walkFiles(codexSessionsDir(), (n) => /^rollout-.*\.jsonl$/.test(n));
  const out = [];
  for (const filePath of files) {
    let st;
    try {
      st = await fs.promises.stat(filePath);
    } catch {
      continue;
    }
    out.push({
      sessionId: CODEX_FILE_RE.exec(filePath)?.[1] ?? "",
      sessionFilePath: filePath,
      projectPath: "",
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

async function findCodexSession(threadId) {
  if (!CODEX_ID_RE.test(threadId)) return undefined;
  const suffix = "-" + threadId + ".jsonl";
  const files = await walkFiles(codexSessionsDir(), (n) => n.startsWith("rollout-") && n.endsWith(suffix));
  const filePath = files[0];
  if (filePath == null) return undefined;
  const st = await fs.promises.stat(filePath);
  return { sessionId: threadId, sessionFilePath: filePath, mtimeMs: st.mtimeMs, sizeBytes: st.size };
}

async function readCodexHead(filePath) {
  for await (const event of readJsonl(filePath)) {
    if (event.type !== "session_meta") return undefined;
    const p = event.payload;
    const source = p.thread_source != null && p.thread_source !== "user" ? p.thread_source : undefined;
    let parentThreadId = p.parent_thread_id;
    const spawn = p.subagent?.thread_spawn;
    if ((parentThreadId == null || parentThreadId.length === 0) && spawn?.parent_thread_id?.length > 0) {
      parentThreadId = spawn.parent_thread_id;
    }
    return {
      threadId: p.id,
      parentThreadId: parentThreadId?.length > 0 ? parentThreadId : undefined,
      cwd: p.cwd,
      classification: { isSubagent: source != null || parentThreadId != null },
    };
  }
  return undefined;
}

function codexTurnIdOf(event) {
  if (event.type === "turn_context") return event.payload.turn_id;
  if (event.type === "response_item") {
    return (
      event.payload.internal_chat_message_metadata_passthrough?.turn_id ?? event.payload.metadata?.turn_id
    );
  }
  if (event.type === "event_msg" && event.payload.type === "task_started") return event.payload.turn_id;
  return undefined;
}

function codexDocOf(event, seq, lastTurnId) {
  const timestamp = event.timestamp ?? "";
  if (event.type === "event_msg") {
    const p = event.payload;
    if (p.type === "exec_command_end") {
      return makeDoc(
        p.call_id ?? (lastTurnId ?? "noturn") + "#" + seq,
        timestamp,
        { toolResult: p.aggregated_output ?? p.formatted_output ?? "" },
        undefined,
        lastTurnId,
        {
          callId: p.call_id,
          isFailedResult: (p.exit_code != null && p.exit_code !== 0) || p.status === "failed" || p.status === "declined",
        }
      );
    }
    if (p.type === "mcp_tool_call_end") {
      return makeDoc(
        p.call_id ?? (lastTurnId ?? "noturn") + "#" + seq,
        timestamp,
        { toolResult: toText(p.result) },
        undefined,
        lastTurnId,
        { callId: p.call_id, isFailedResult: p.result != null && (p.result.Err != null || p.result.isError === true || p.result.Ok?.isError === true) }
      );
    }
    return undefined;
  }
  if (event.type !== "response_item") return undefined;
  const p = event.payload;
  const turnId = p.internal_chat_message_metadata_passthrough?.turn_id ?? lastTurnId;
  const uuid = p.id ?? (turnId ?? "noturn") + "#" + seq;
  if (p.type === "message") {
    const text = (p.content ?? []).map((c) => c.text ?? "").join("\n");
    if (p.role === "user") {
      if (text.trimStart().startsWith("<environment_context>")) return undefined;
      return makeDoc(uuid, timestamp, { text }, { startsDocument: true }, turnId);
    }
    if (p.role === "assistant") {
      return makeDoc(uuid, timestamp, { text }, { isResponse: true }, turnId);
    }
    return undefined;
  }
  if (CODEX_TOOL_TYPES.has(p.type)) {
    const name = p.name ?? p.namespace ?? "tool";
    return makeDoc(
      uuid,
      timestamp,
      { toolCall: (name + " " + toText(p.arguments ?? p.input)).trim() },
      { isResponse: true },
      turnId,
      { callId: p.call_id }
    );
  }
  return undefined;
}

async function* codexRawDocs(filePath) {
  let seq = 0;
  let lastTurnId;
  for await (const event of readJsonl(filePath)) {
    lastTurnId = codexTurnIdOf(event) ?? lastTurnId;
    const doc = codexDocOf(event, seq, lastTurnId);
    if (doc != null) {
      yield doc;
      seq++;
    }
  }
}

function codexReadDocuments(filePath, meta) {
  return assembleTurns(codexRawDocs(filePath), meta, mergePayloadFields);
}

async function codexCompactionBoundariesMs(filePath) {
  const out = [];
  for await (const event of readJsonl(filePath)) {
    // Two shapes seen in the wild: top-level "compacted" records (0.162.x)
    // and event_msg/context_compacted (earlier builds).
    const isBoundary =
      event.type === "compacted" ||
      (event.type === "event_msg" && event.payload?.type === "context_compacted") ||
      (event.type === "response_item" && event.payload?.type === "compaction");
    if (!isBoundary) continue;
    const ms = Date.parse(event.timestamp ?? "");
    if (!Number.isNaN(ms)) out.push(ms);
  }
  return out;
}

async function resolveCodexScope(options) {
  if (options.sessions === "this") {
    if (options.sessionId == null || options.sessionId === "") return [];
    // follow the parent-thread chain to the root thread's file, collecting cwd
    const seen = new Set();
    let current = options.sessionId;
    let file = await findCodexSession(current);
    let cwd;
    while (file != null && !seen.has(current)) {
      seen.add(current);
      const head = await readCodexHead(file.sessionFilePath);
      cwd = head?.cwd ?? cwd;
      const parent = head?.parentThreadId;
      if (parent == null || seen.has(parent)) break;
      file = await findCodexSession(parent);
      current = parent;
    }
    if (file == null) return [];
    return [{ sessionFilePath: file.sessionFilePath, sessionId: file.sessionId, projectPath: cwd ?? "" }];
  }
  const all = applySessionWindow(await listCodexSessions(), options);
  const mains = [];
  for (const s of all) {
    const head = await readCodexHead(s.sessionFilePath);
    if (!head?.classification.isSubagent) mains.push({ ...s, cwd: head?.cwd });
  }
  if (options.sessions === "all") return mains.map(({ cwd, ...s }) => s);
  const anchor = await realNorm(options.projectDir ?? process.cwd());
  const kept = [];
  for (const s of mains) {
    if (s.cwd != null && isInsidePath(await realNorm(s.cwd), anchor)) kept.push(s);
  }
  return kept.map((s) => ({ sessionFilePath: s.sessionFilePath, sessionId: s.sessionId, projectPath: s.cwd }));
}

// ---------------------------------------------------------------------------
// Copilot host (~/.copilot/session-state/<id>/events.jsonl)
// ---------------------------------------------------------------------------
function copilotStateDir() {
  return path.join(process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot"), "session-state");
}

async function listCopilotSessions() {
  const root = copilotStateDir();
  const out = [];
  let dirs;
  try {
    dirs = await fs.promises.readdir(root);
  } catch {
    return out;
  }
  for (const sessionId of dirs) {
    const eventsPath = path.join(root, sessionId, "events.jsonl");
    let st;
    try {
      st = await fs.promises.stat(eventsPath);
    } catch {
      continue;
    }
    out.push({
      sessionId,
      sessionFilePath: eventsPath,
      eventsJsonlPath: eventsPath,
      projectPath: "",
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

async function readCopilotCwd(filePath) {
  let seen = 0;
  for await (const event of readJsonl(filePath)) {
    const cwd = event.data?.cwd ?? event.cwd ?? event.data?.context?.cwd;
    if (typeof cwd === "string" && cwd !== "") return cwd;
    if (++seen >= SESSION_HEAD_MAX_LINES) break;
  }
  return undefined;
}

function copilotDocOf(event) {
  const timestamp = event.timestamp;
  switch (event.type) {
    case "user.message":
      return makeDoc(event.id, timestamp, { text: event.data.content ?? "" }, { startsDocument: true });
    case "assistant.message": {
      const toolCall = (event.data.toolRequests ?? [])
        .map((r) => (r.name + " " + toText(r.arguments)).trim())
        .join("\n");
      return makeDoc(
        event.id,
        timestamp,
        { text: event.data.content ?? "", toolCall },
        { isResponse: true },
        event.data.turnId ?? event.id
      );
    }
    case "tool.execution_complete":
      return makeDoc(event.id, timestamp, { toolResult: event.data.result?.content ?? "" }, undefined, undefined, {
        callId: event.data.toolCallId,
        isFailedResult: !event.data.success,
      });
    default:
      return undefined;
  }
}

async function* copilotRawDocs(filePath) {
  for await (const event of readJsonl(filePath)) {
    if (event.agentId != null) continue;
    const doc = copilotDocOf(event);
    if (doc != null) yield doc;
  }
}

function copilotReadDocuments(filePath, meta) {
  return assembleTurns(copilotRawDocs(filePath), meta, mergePayloadFields);
}

async function copilotCompactionBoundariesMs(filePath) {
  const out = [];
  for await (const event of readJsonl(filePath)) {
    if (event.type !== "session.compaction_complete" || !event.data.success) continue;
    const ms = Date.parse(event.timestamp);
    if (!Number.isNaN(ms)) out.push(ms);
  }
  return out;
}

async function resolveCopilotScope(options) {
  const all = applySessionWindow(await listCopilotSessions(), options);
  if (options.sessions === "this") {
    if (options.sessionId == null || options.sessionId === "") return [];
    const found = all.find((s) => s.sessionId === options.sessionId);
    if (found == null) return [];
    const cwd = await readCopilotCwd(found.eventsJsonlPath);
    return [{ sessionFilePath: found.eventsJsonlPath, sessionId: found.sessionId, projectPath: cwd ?? "" }];
  }
  if (options.sessions === "all") {
    return all.map((s) => ({ sessionFilePath: s.eventsJsonlPath, sessionId: s.sessionId, projectPath: "" }));
  }
  const anchor = await realNorm(options.projectDir ?? process.cwd());
  const kept = [];
  for (const s of all) {
    const cwd = await readCopilotCwd(s.eventsJsonlPath);
    if (cwd != null && isInsidePath(await realNorm(cwd), anchor)) {
      kept.push({ sessionFilePath: s.eventsJsonlPath, sessionId: s.sessionId, projectPath: cwd });
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Host registry
// ---------------------------------------------------------------------------
function hostAdapter(host) {
  switch (host) {
    case "claude":
      return {
        resolveScopeFiles: resolveClaudeScope,
        readDocuments: claudeReadDocuments,
        readCompactionBoundariesMs: claudeCompactionBoundariesMs,
      };
    case "codex":
      return {
        resolveScopeFiles: resolveCodexScope,
        readDocuments: codexReadDocuments,
        readCompactionBoundariesMs: codexCompactionBoundariesMs,
      };
    case "copilot":
      return {
        resolveScopeFiles: resolveCopilotScope,
        readDocuments: copilotReadDocuments,
        readCompactionBoundariesMs: copilotCompactionBoundariesMs,
      };
  }
}

function sessionIdEnv(host) {
  switch (host) {
    case "claude":
      return "CLAUDE_CODE_SESSION_ID";
    case "codex":
      return "CODEX_THREAD_ID";
    case "copilot":
      return "COPILOT_AGENT_SESSION_ID";
  }
}

function detectHost() {
  if (process.env.TOKENSAVER_HOST === "claude" || process.env.TOKENSAVER_HOST === "codex") return process.env.TOKENSAVER_HOST;
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) return "claude";
  if (process.env.CODEX_THREAD_ID) return "codex";
  if (process.env.COPILOT_AGENT_SESSION_ID) return "copilot";
  return detectPluginHost();
}

// ---------------------------------------------------------------------------
// Scope / time windows
// ---------------------------------------------------------------------------
function applySessionWindow(sessions, options) {
  let out = sessions;
  if (options.sinceMs != null) out = out.filter((s) => s.mtimeMs >= options.sinceMs);
  if (options.sessionsLimit != null && options.untilMs == null) out = out.slice(0, options.sessionsLimit);
  return out;
}

function isSelfPollution(fields) {
  const text = fields.text ?? "";
  if (
    text.includes("<command-name>" + SELF_COMMAND) ||
    text.includes("Re-invocation of " + SELF_COMMAND) ||
    text.includes(SELF_SKILL_PREFIX) ||
    text.trimStart().startsWith(SELF_SLASH_PREFIX)
  ) {
    return true;
  }
  const toolCall = fields.toolCall ?? "";
  return toolCall.includes(SELF_TOOLCALL) || toolCall.includes(SELF_SUBAGENT);
}

async function computeSinceBound(filePath, options, adapter) {
  const bounds = [];
  if (options.sinceMs != null) bounds.push(options.sinceMs);
  if (
    options.sinceLastCompactions != null &&
    options.sinceLastCompactions > 0 &&
    adapter.readCompactionBoundariesMs != null
  ) {
    const marks = await adapter.readCompactionBoundariesMs(filePath);
    if (marks.length >= options.sinceLastCompactions) {
      bounds.push(marks[marks.length - options.sinceLastCompactions]);
    }
  }
  return bounds.length > 0 ? Math.max(...bounds) : undefined;
}

function windowedReadDocuments(adapter, options) {
  return async function* (filePath, meta) {
    const sinceBound = await computeSinceBound(filePath, options, adapter);
    const untilMs = options.untilMs;
    for await (const doc of adapter.readDocuments(filePath, meta)) {
      if (isSelfPollution(doc.fields)) continue;
      const ms = Date.parse(doc.timestamp);
      if (sinceBound != null && ms < sinceBound) continue;
      if (untilMs != null && ms > untilMs) continue;
      yield doc;
    }
  };
}

// ---------------------------------------------------------------------------
// Pre-filter: for project/all scopes, drop session files lacking every term
// ---------------------------------------------------------------------------
function distinctTerms(query) {
  const seen = new Set();
  for (const t of tokenize(query)) {
    if (t.length >= PREFILTER_MIN_LEN) seen.add(t);
  }
  return [...seen];
}

async function fileContainsAnyTerm(filePath, terms, carryLen) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: PREFILTER_CHUNK });
  let carry = "";
  try {
    for await (const chunk of stream) {
      const hay = (carry + chunk).toLowerCase();
      for (const t of terms) {
        if (hay.includes(t)) {
          stream.destroy();
          return true;
        }
      }
      carry = hay.slice(-(carryLen - 1));
    }
  } catch {
    return true; // unreadable files are kept rather than silently excluded
  }
  return false;
}

async function prefilterSessions(sessions, scope, query) {
  if (scope === "this") return sessions;
  const terms = distinctTerms(query);
  if (terms.length === 0 || sessions.length === 0) return sessions;
  const carryLen = Math.max(...terms.map((t) => t.length));
  const kept = [];
  for (const s of sessions) {
    if (await fileContainsAnyTerm(s.sessionFilePath, terms, carryLen)) kept.push(s);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Matching & ranking
// ---------------------------------------------------------------------------
function fieldValue(fields, name) {
  switch (name) {
    case "text":
      return fields.text;
    case "tool":
      return fields.toolCall;
    case "result":
      return fields.toolResult;
  }
  return "";
}

function joinedFields(fields, names) {
  return names.map((n) => fieldValue(fields, n)).join("\n");
}

function isDefaultFieldSet(names) {
  return names.length === DEFAULT_MATCH_FIELDS.length && DEFAULT_MATCH_FIELDS.every((f) => names.includes(f));
}

// Keep docs matching ALL terms if any exist, else docs matching ANY term.
function termFilter(docs, fieldsOf, matchFields, terms) {
  if (terms.length === 0) {
    return docs.filter((d) => joinedFields(fieldsOf(d), matchFields).trim() !== "");
  }
  const all = [];
  const any = [];
  for (const d of docs) {
    const hay = joinedFields(fieldsOf(d), matchFields).toLowerCase();
    let hits = 0;
    for (const t of terms) {
      if (hay.includes(t)) hits++;
    }
    if (hits !== 0) {
      any.push(d);
      if (hits === terms.length) all.push(d);
    }
  }
  return all.length > 0 ? all : any;
}

// BM25F index over {text, toolCall}
function buildBm25Index(docs, params) {
  const fieldNames = Object.keys(params.fields);
  const docRows = [];
  const df = new Map();
  const totalLen = {};
  for (const name of fieldNames) totalLen[name] = 0;
  for (const doc of docs) {
    const fieldTf = {};
    const fieldLen = {};
    const seen = new Set();
    for (const name of fieldNames) {
      const toks = tokenize(doc.fields[name] ?? "");
      fieldLen[name] = toks.length;
      totalLen[name] += toks.length;
      const tf = new Map();
      for (const t of toks) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
        seen.add(t);
      }
      fieldTf[name] = tf;
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    docRows.push({ key: doc.key, fieldTf, fieldLen });
  }
  const n = docRows.length || 1;
  const avgFieldLen = {};
  for (const name of fieldNames) avgFieldLen[name] = totalLen[name] / n;
  return { params, fieldNames, docs: docRows, df, n: docRows.length, avgFieldLen };
}

function bm25Idf(index, term) {
  const d = index.df.get(term) ?? 0;
  return Math.log(1 + (index.n - d + 0.5) / (d + 0.5));
}

function bm25fScore(index, query, params = index.params) {
  const terms = [...new Set(tokenize(query))];
  const idf = new Map();
  for (const t of terms) idf.set(t, bm25Idf(index, t));
  const { k1, fields } = params;
  const out = new Array(index.docs.length);
  for (let i = 0; i < index.docs.length; i++) {
    const row = index.docs[i];
    let score = 0;
    for (const t of terms) {
      let f = 0;
      for (const name of index.fieldNames) {
        const w = fields[name];
        if (w == null) continue;
        const tf = row.fieldTf[name].get(t);
        if (tf == null) continue;
        const norm = 1 - w.b + w.b * (row.fieldLen[name] / (index.avgFieldLen[name] || 1));
        f += (w.boost * tf) / (norm || 1);
      }
      if (f > 0) score += (idf.get(t) ?? 0) * (f / (k1 + f));
    }
    out[i] = { key: row.key, score };
  }
  return out;
}

const EMPTY_HEAVY = { toolResult: "", thinking: "" };

// Whether to blank heavy fields on a doc: only when "result" is a match field
// and the doc's own selected fields contain none of the query terms.
function heavyFieldDropper(query, matchFields) {
  if (!matchFields.includes("result")) return () => false;
  const terms = tokenize(query);
  return (doc) => termFilter([doc], (d) => d.fields, matchFields, terms).length > 0;
}

async function buildIndex(sessions, readDocs, params = BM25F_PARAMS, dropPredicate) {
  const documentsByKey = new Map();
  const sessionFileById = new Map();
  const rows = [];
  for (const s of sessions) {
    sessionFileById.set(s.sessionId, s);
    const meta = { sessionId: s.sessionId, projectPath: s.projectPath };
    for await (const doc of readDocs(s.sessionFilePath, meta)) {
      const stored =
        dropPredicate == null || dropPredicate(doc)
          ? doc
          : { ...doc, fields: { ...doc.fields, ...EMPTY_HEAVY } };
      documentsByKey.set(doc.key, stored);
      rows.push({ key: doc.key, fields: { text: doc.fields.text, toolCall: doc.fields.toolCall } });
    }
  }
  return { index: buildBm25Index(rows, params), documentsByKey, readDocs, sessionFileById, heavyFieldsDropped: dropPredicate != null };
}

// Re-read heavy fields for surviving docs when they were dropped at index time.
async function reloadHeavyFields(indexCtx, ranked) {
  if (!indexCtx.heavyFieldsDropped || ranked.length === 0) return ranked;
  const wanted = new Map();
  for (const r of ranked) {
    const set = wanted.get(r.document.sessionId) ?? new Set();
    set.add(r.document.key);
    wanted.set(r.document.sessionId, set);
  }
  const found = new Map();
  for (const [sessionId, keys] of wanted) {
    const s = indexCtx.sessionFileById.get(sessionId);
    if (s == null) continue;
    const meta = { sessionId: s.sessionId, projectPath: s.projectPath };
    let remaining = keys.size;
    for await (const doc of indexCtx.readDocs(s.sessionFilePath, meta)) {
      if (keys.has(doc.key) && (found.set(doc.key, doc.fields), --remaining === 0)) break;
    }
  }
  return ranked.map((r) => {
    const fields = found.get(r.document.key);
    return fields == null ? r : { document: { ...r.document, fields }, score: r.score };
  });
}

function rankCompare(a, b) {
  return b.score - a.score || Date.parse(b.document.timestamp) - Date.parse(a.document.timestamp);
}

async function rank(indexCtx, query, limit, matchFields, params = indexCtx.index.params, reloadHeavy = false) {
  const scored = bm25fScore(indexCtx.index, query, params);
  const positive = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const queryTerms = tokenize(query);
  if (isDefaultFieldSet(matchFields)) {
    const ranked = [];
    for (const s of positive) {
      const doc = indexCtx.documentsByKey.get(s.key);
      if (doc != null) ranked.push({ document: doc, score: s.score });
    }
    ranked.sort(rankCompare);
    const top = ranked.slice(0, limit);
    return reloadHeavy ? reloadHeavyFields(indexCtx, top) : top;
  }
  if (matchFields.includes("result")) {
    const scoreByKey = new Map(scored.map((s) => [s.key, s.score]));
    const all = [...indexCtx.documentsByKey.values()].map((doc) => ({
      document: doc,
      score: scoreByKey.get(doc.key) ?? 0,
    }));
    const filtered = termFilter(all, (r) => r.document.fields, matchFields, queryTerms);
    filtered.sort(rankCompare);
    return filtered.slice(0, limit);
  }
  const ranked = [];
  for (const s of positive) {
    const doc = indexCtx.documentsByKey.get(s.key);
    if (doc != null) ranked.push({ document: doc, score: s.score });
  }
  const filtered = termFilter(ranked, (r) => r.document.fields, matchFields, queryTerms);
  filtered.sort(rankCompare);
  const top = filtered.slice(0, limit);
  return reloadHeavy ? reloadHeavyFields(indexCtx, top) : top;
}

// ---------------------------------------------------------------------------
// recallId
// ---------------------------------------------------------------------------
function recallId(sessionId, turnId) {
  return sessionId + ":" + turnId;
}

function parseRecallId(id) {
  const i = id.indexOf(":");
  if (i <= 0 || i >= id.length - 1) return undefined;
  return { sessionId: id.slice(0, i), turnId: id.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// Output budget (cli-stdout on claude: bytes, BASH_MAX_OUTPUT_LENGTH)
// ---------------------------------------------------------------------------
function envInt(name, fallback, cap) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return cap != null ? Math.min(n, cap) : n;
}

function outputUnit(host) {
  return "bytes";
}

function outputBudget(host) {
  switch (host) {
    case "claude":
      return envInt("BASH_MAX_OUTPUT_LENGTH", 30000, 150000);
    case "codex":
      return 40000;
    case "copilot":
      return envInt("COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES", 20480);
  }
  return 30000;
}

// Costs are measured on the JSON-serialized form of each string value,
// matching the wire size the harness will actually see.
const measureJson = (v) => Buffer.byteLength(JSON.stringify(v)) - 2;

function truncationMarker(truncated, host) {
  const unit = outputUnit(host);
  return "\n\n…[recall truncated " + truncated.toLocaleString() + " " + unit + " to fit the " + host + " output budget]";
}

// Fit `text` into `budget.remaining` units; appends the truncation marker when
// there is room for it, returns "" when there is not.
function fitText(text, budget) {
  const cost = measureJson(text);
  if (cost <= budget.remaining) {
    budget.remaining -= cost;
    return text;
  }
  const markerCost = measureJson(truncationMarker(cost, budget.host));
  if (budget.remaining < markerCost) return "";
  const { text: kept, unitsKept } = truncateToUnits(text, Math.max(0, budget.remaining - markerCost));
  const marker = truncationMarker(cost - unitsKept, budget.host);
  budget.remaining = Math.max(0, budget.remaining - unitsKept - measureJson(marker));
  return kept + marker;
}

// Truncate at a newline boundary inside the unit budget; fall back to a
// codepoint scan when even the first line does not fit.
function truncateToUnits(text, maxUnits) {
  if (measureJson(text) <= maxUnits) return { text, unitsKept: measureJson(text) };
  const nlCost = measureJson("\n");
  let keptEnd = 0;
  let used = 0;
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = text.length;
    const lineCost = (pos === 0 ? 0 : nlCost) + measureJson(text.slice(pos, nl));
    if (used + lineCost > maxUnits) {
      if (pos !== 0) break;
      // first line alone exceeds the budget: cut by codepoint
      let cut = 0;
      let lineUsed = 0;
      for (const ch of text) {
        const c = measureJson(ch);
        if (lineUsed + c > maxUnits) break;
        lineUsed += c;
        cut += ch.length;
      }
      return { text: text.slice(0, cut), unitsKept: lineUsed };
    }
    used += lineCost;
    keptEnd = nl;
    pos = nl + 1;
  }
  return { text: text.slice(0, keptEnd), unitsKept: used };
}

// Emit one of the "heavy" fields (toolResult, thinking): the leftover share is
// split evenly across the heavy fields still to emit.
function fitShared(text, parentBudget, fieldsLeft) {
  const share = Math.floor(parentBudget.remaining / Math.max(1, fieldsLeft));
  const inner = { host: parentBudget.host, remaining: share };
  const out = fitText(text, inner);
  parentBudget.remaining = Math.max(0, parentBudget.remaining - (share - inner.remaining));
  return out;
}

function fitsEnvelope(obj, budget) {
  const cost = Buffer.byteLength(JSON.stringify(obj)) + 1;
  if (cost > budget.remaining) return false;
  budget.remaining -= cost;
  return true;
}

function envelopeFits(obj, hasResult, hasThinking, budget) {
  return fitsEnvelope(
    {
      ...obj,
      text: "",
      toolCall: "",
      ...(hasResult ? { toolResult: "" } : {}),
      ...(hasThinking ? { thinking: "" } : {}),
    },
    budget
  );
}

function resultEnvelope(doc) {
  return {
    recallId: doc.recallId ?? recallId(doc.sessionId, doc.turnId),
    sessionId: doc.sessionId,
    projectPath: doc.projectPath,
    timestamp: doc.timestamp,
    score: Number(doc.score.toFixed(4)),
  };
}

// Emit a result's fields within its share of the budget: text+toolCall get the
// whole share (or half when heavy fields are emitted); the heavy fields split
// what remains.
function emitFields(fields, hasResult, hasThinking, budget) {
  const share = Math.floor(budget.remaining / Math.max(1, budget.resultsRemaining));
  let heavy = (hasResult ? 1 : 0) + (hasThinking ? 1 : 0);
  const sub = { host: budget.host, remaining: heavy === 0 ? share : Math.floor(share * 0.5) };
  const text = fitText(fields.text, sub);
  const toolCall = fitText(fields.toolCall, sub);
  sub.remaining = share - ((heavy === 0 ? share : Math.floor(share * 0.5)) - sub.remaining);
  let toolResult;
  if (hasResult) {
    toolResult = fitShared(fields.toolResult, sub, heavy);
    heavy -= 1;
  }
  const thinking = hasThinking ? fitShared(fields.thinking, sub, heavy) : undefined;
  budget.remaining = Math.max(0, budget.remaining - (share - sub.remaining));
  budget.resultsRemaining = Math.max(0, budget.resultsRemaining - 1);
  return {
    text,
    toolCall,
    ...(hasResult ? { toolResult } : {}),
    ...(hasThinking ? { thinking } : {}),
  };
}

function emitResults(ranked, hasResult, hasThinking, budget) {
  const survivors = [];
  for (const r of ranked) {
    const env = resultEnvelope(r.document ?? r);
    if (!envelopeFits(env, hasResult, hasThinking, budget)) break;
    survivors.push({ envelope: env, result: r });
  }
  budget.resultsRemaining = Math.max(1, survivors.length);
  return survivors.map(({ envelope, result }) => {
    const doc = result.document ?? result;
    const fields = doc.fields ?? doc;
    return { ...envelope, ...emitFields(fields, hasResult, hasThinking, budget) };
  });
}

function fullEnvelope(results, guidance, host, sessions, hasResult, hasThinking) {
  const envelope = { sessions, count: results.length, results: [], guidance };
  const budget = { host, remaining: outputBudget(host) - (Buffer.byteLength(JSON.stringify(envelope)) + 1), resultsRemaining: 1 };
  const emitted = emitResults(results, hasResult, hasThinking, budget);
  return { ...envelope, count: emitted.length, results: emitted };
}

function titlesEnvelope(rows, totalMatched, guidance, host, sessions) {
  const envelope = { sessions, count: rows.length, totalMatched, rows: [], guidance };
  const budget = { host, remaining: outputBudget(host) - (Buffer.byteLength(JSON.stringify(envelope)) + 1), resultsRemaining: 1 };
  const kept = [];
  for (const row of rows) {
    if (!fitsEnvelope(row, budget)) break;
    kept.push(row);
  }
  return { ...envelope, count: kept.length, rows: kept };
}

// ---------------------------------------------------------------------------
// Guidance (exact strings are part of the behavioral spec)
// ---------------------------------------------------------------------------
function fullGuidance(query, scope, results, currentSessionId) {
  const isFileAsk = FILE_ASK_RE.test(query);
  const next = NEXT_SCOPE[scope];
  const tips = [];
  if (results.length === 0) {
    if (next != null) {
      tips.push("Nothing matched. Do NOT just reword — cut to 2–3 distinctive terms (identifiers, filenames, error strings).");
      if (isFileAsk) {
        tips.push("This looks like a file/path ask — enumerate with your terms: --show titles --in tool --sessions " + scope + " lists matching turns, then --id <row>.");
      }
      tips.push("Widen scope one rung: --sessions " + next + " (do this ONCE).");
      tips.push("If you set --since/--until, relax the bound.");
      return { ifThisIsntIt: tips };
    }
    if (isFileAsk) {
      tips.push("Last lever for a file/path ask: enumerate with your terms — --show titles --in tool --sessions " + scope + ".");
    }
    tips.push("If you set --since/--until, relax the bound and retry ONCE.");
    tips.push(STOP_AT_WIDEST);
    return { ifThisIsntIt: tips };
  }
  if (scope !== "this" && currentSessionId != null && results[0].sessionId === currentSessionId) {
    const other = results.find((r) => r.sessionId !== currentSessionId);
    if (other != null) {
      tips.push("Rank 1 is THIS session discussing your question, not the original answer — skip it.");
      tips.push("Drill the top hit from another session: --id " + other.recallId + " (add --include-tool-result if the answer is in a tool output).");
      tips.push("Or re-search with --in tool to rank only turns that RAN a matching command, skipping prose chatter.");
    } else {
      tips.push("Every hit is THIS session discussing your question, not the original answer — add a distinctive identifier (a filename, symbol, or error string) and re-search.");
    }
  } else {
    tips.push("Do NOT reword and re-search — a ranked re-query rarely out-ranks this one.");
    tips.push("Drill a hit in full: --id " + results[0].recallId + " (add --include-tool-result if the answer is in a tool output).");
  }
  if (isFileAsk) {
    tips.push("Your query names a file/path — enumerate with your terms: --show titles --in tool --sessions " + scope + " lists matching turns, then --id <row>.");
  }
  if (next != null) {
    tips.push("Only if nothing here fits: widen scope one rung (" + scope + " → " + next + "), ONCE.");
  } else {
    tips.push("Already at the widest scope. If a hit here answers it, use it; if none genuinely does, the answer is NOT in session history — report that and STOP. Do NOT reword and re-search.");
  }
  return { ifThisIsntIt: tips };
}

function titlesGuidance(scope, totalMatched) {
  const next = NEXT_SCOPE[scope];
  const tips = [];
  if (totalMatched === 0) {
    if (next != null) {
      tips.push("No turn matches these terms at --sessions " + scope + ". Widen ONCE: --sessions " + next + ".");
      tips.push("If the widest scope is also empty, the turn does not exist — report that and STOP.");
    } else {
      tips.push(STOP_AT_WIDEST);
    }
    return { ifThisIsntIt: tips };
  }
  tips.push("Pick the row that fits and drill it in full: --id <id> (add --include-tool-result for tool output).");
  return { ifThisIsntIt: tips };
}

// ---------------------------------------------------------------------------
// Query paths
// ---------------------------------------------------------------------------
function toResult({ document, score }) {
  return {
    key: document.key,
    recallId: recallId(document.sessionId, document.turnId),
    sessionId: document.sessionId,
    projectPath: document.projectPath,
    timestamp: document.timestamp,
    score,
    memberUuids: document.memberUuids,
    text: document.fields.text,
    toolCall: document.fields.toolCall,
    toolResult: document.fields.toolResult,
    thinking: document.fields.thinking,
  };
}

async function runSearch(options, host) {
  const adapter = hostAdapter(host);
  const sessions = await prefilterSessions(await adapter.resolveScopeFiles(options), options.sessions, options.query);
  if (sessions.length === 0) return [];
  const matchFields = options.matchFields ?? DEFAULT_MATCH_FIELDS;
  const dropHeavy = (options.includeToolResult ?? false) || (options.includeThinking ?? false) ? undefined : heavyFieldDropper(options.query, matchFields);
  const indexCtx = await buildIndex(sessions, windowedReadDocuments(adapter, options), undefined, dropHeavy);
  const reloadHeavy = (options.includeToolResult ?? false) || (options.includeThinking ?? false);
  const ranked = await rank(indexCtx, options.query, options.limit ?? DEFAULT_LIMIT, matchFields, undefined, reloadHeavy);
  return ranked.map(toResult);
}

async function runDrill(id, options, host) {
  const parsed = parseRecallId(id ?? "");
  if (parsed == null) return { error: 'Malformed --id "' + (id ?? "") + '". Expected "<sessionId>:<turnId>".' };
  const adapter = hostAdapter(host);
  const sessions = await adapter.resolveScopeFiles({
    query: "",
    sessions: "this",
    sessionId: parsed.sessionId,
    projectDir: options.projectDir,
  });
  for (const s of sessions) {
    const meta = { sessionId: s.sessionId, projectPath: s.projectPath };
    for await (const doc of adapter.readDocuments(s.sessionFilePath, meta)) {
      if (doc.turnId === parsed.turnId) {
        return {
          recallId: id,
          sessionId: doc.sessionId,
          projectPath: doc.projectPath,
          timestamp: doc.timestamp,
          text: doc.fields.text,
          toolCall: doc.fields.toolCall,
          toolResult: doc.fields.toolResult,
          thinking: doc.fields.thinking,
        };
      }
    }
  }
  return undefined;
}

function firstLineOf(fields) {
  const source = fields.toolCall.trim() !== "" ? fields.toolCall : fields.text;
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (t !== "") return t;
  }
  return "";
}

function rowName(fields) {
  const s = firstLineOf(fields);
  return s.length <= TITLE_MAX_LEN ? s : s.slice(0, TITLE_MAX_LEN - 1) + ELLIPSIS;
}

async function runTitles(options, host) {
  const adapter = hostAdapter(host);
  const sessions = await prefilterSessions(await adapter.resolveScopeFiles(options), options.sessions, options.query ?? "");
  const readDocs = windowedReadDocuments(adapter, options);
  const matchFields = options.matchFields ?? DEFAULT_MATCH_FIELDS;
  const rows = [];
  for (const s of sessions) {
    const meta = { sessionId: s.sessionId, projectPath: s.projectPath };
    for await (const doc of readDocs(s.sessionFilePath, meta)) {
      rows.push({
        row: { id: recallId(doc.sessionId, doc.turnId), name: rowName(doc.fields), timestamp: doc.timestamp },
        haystack: joinedFields(doc.fields, matchFields),
      });
    }
  }
  const terms = tokenize(options.query ?? "");
  const filtered = termFilter(rows, (r) => ({ text: r.haystack, toolCall: "", toolResult: "", thinking: "" }), ["text"], terms);
  filtered.sort((a, b) => Date.parse(b.row.timestamp) - Date.parse(a.row.timestamp));
  return { rows: filtered.slice(0, options.limit ?? DEFAULT_LIMIT).map((r) => r.row), totalMatched: filtered.length };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const FLAG_DEFS = [
  { flag: "--id", arg: "<sessionId:turnId>", usage: "Fetch one prior turn by its recallId (drill-down, no ranking)." },
  { flag: "--show", arg: "<" + SHOW_MODES.join("|") + ">", usage: "full (default) ranks and drills whole turns; titles enumerates in-scope turns as tiny {id,name,timestamp} rows (no ranking), filtered by <query> and --in." },
  { flag: "--in", arg: "<" + MATCH_FIELDS.join(",") + ">", usage: "Which field(s) the query matches (default: text,tool). Repeatable or comma-separated. --in tool skips prose chatter." },
  { flag: "--sessions", arg: "<" + SCOPES.join("|") + ">", usage: "Which sessions to search (default: this). WHERE, orthogonal to the WHEN flags." },
  { flag: "--sessions-limit", arg: "<N>", usage: "Cap --sessions project/all to the N most-recent sessions (ignored when --until is set)." },
  { flag: "--since", arg: "<when>", usage: 'Keep only turns at or after <when>: ISO date, "today", "yesterday", or "<N> min|hours|days ago".' },
  { flag: "--until", arg: "<when>", usage: "Keep only turns at or before <when> (same formats). Upper bound; pairs with --since." },
  { flag: "--since-last-compactions", arg: "<N>", usage: "Keep only turns after the Nth-most-recent compaction boundary." },
  { flag: "--project-dir", arg: "<dir>", usage: "Anchor repo the --sessions project filter resolves against (default: cwd)." },
  { flag: "--limit", arg: "<k>", usage: "Max results (default: " + DEFAULT_LIMIT + ")." },
  { flag: "--host", arg: "<" + HOSTS.join("|") + ">", usage: "Which harness's transcripts to search (default: detected host, else claude)." },
  { flag: "--session", arg: "<id>", usage: "With --sessions this: session id (default: $CLAUDE_CODE_SESSION_ID)." },
  { flag: "--include-tool-result", usage: "Emit each match’s tool output." },
  { flag: "--include-thinking", usage: "Emit each match’s reasoning." },
  { flag: "--pretty", usage: "Pretty-print the JSON output." },
];

function usage() {
  const lines = FLAG_DEFS.map((d) => "  " + (d.arg != null ? d.flag + " " + d.arg : d.flag) + "  " + d.usage);
  return [
    "Usage: " + CLI_NAME + " <query> [options]",
    "       " + CLI_NAME + " [options] -- <query starting with ->",
    "       " + CLI_NAME + " --id <sessionId:turnId>",
    "       " + CLI_NAME + " --show titles [--in tool] [--sessions ...]",
    "",
    "Options:",
    ...lines,
  ].join("\n");
}

function startOfToday(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.getTime();
}

function parseWhen(raw) {
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (v === "now") return Date.now();
  if (v === "today") return startOfToday(0);
  if (v === "yesterday") return startOfToday(-1);
  const m = REL_AGO_RE.exec(v);
  if (m != null) return Date.now() - Number.parseInt(m[1], 10) * UNIT_MS[m[2][0]];
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

function mustValue(flag, value) {
  if (value == null || value.startsWith("--")) throw new UsageError("Missing value for " + flag + ".");
  return value;
}

function parsePosInt(flag, raw) {
  if (!POS_INT_RE.test(raw.trim())) throw new UsageError(flag + " expects a positive integer, got \"" + raw + "\".");
  return Number.parseInt(raw, 10);
}

function parseWhenFlag(flag, raw) {
  const ms = parseWhen(raw);
  if (ms == null) {
    throw new UsageError(flag + ' could not parse "' + raw + '". Use an ISO date, "today", "yesterday", or "<N> min|hours|days ago".');
  }
  return ms;
}

function parseArgs(argv) {
  const parsed = {
    options: {
      query: "",
      sessions: "this",
      sessionId: undefined,
      sessionsLimit: undefined,
      sinceMs: undefined,
      untilMs: undefined,
      sinceLastCompactions: undefined,
      projectDir: undefined,
      limit: undefined,
    },
    matchFieldSet: new Set(),
    id: undefined,
    show: "full",
    host: undefined,
    includeToolResult: false,
    includeThinking: false,
    pretty: false,
  };
  let positionalSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      const rest = argv.slice(i + 1).join(" ");
      if (rest !== "") parsed.options.query = rest;
      break;
    }
    if (!arg.startsWith("--")) {
      if (positionalSeen) {
        parsed.options.query += " " + arg;
      } else {
        parsed.options.query = arg;
        positionalSeen = true;
      }
      continue;
    }
    const next = () => mustValue(arg, argv[++i]);
    switch (arg) {
      case "--id":
        parsed.id = next();
        break;
      case "--show": {
        const v = next();
        if (!SHOW_MODES.includes(v)) throw new UsageError('Unknown --show "' + v + '". Expected one of: ' + SHOW_MODES.join(", ") + ".");
        parsed.show = v;
        break;
      }
      case "--in": {
        for (const part of next().split(",")) {
          const f = part.trim();
          if (f === "") continue;
          if (!MATCH_FIELDS.includes(f)) throw new UsageError('Unknown --in "' + f + '". Expected one or more of: ' + MATCH_FIELDS.join(", ") + ".");
          parsed.matchFieldSet.add(f);
        }
        break;
      }
      case "--sessions": {
        const v = next();
        if (!SCOPES.includes(v)) throw new UsageError('Unknown --sessions "' + v + '". Expected one of: ' + SCOPES.join(", ") + ".");
        parsed.options.sessions = v;
        break;
      }
      case "--sessions-limit":
        parsed.options.sessionsLimit = parsePosInt(arg, next());
        break;
      case "--since":
        parsed.options.sinceMs = parseWhenFlag(arg, next());
        break;
      case "--until":
        parsed.options.untilMs = parseWhenFlag(arg, next());
        break;
      case "--since-last-compactions":
        parsed.options.sinceLastCompactions = parsePosInt(arg, next());
        break;
      case "--project-dir":
        parsed.options.projectDir = next();
        break;
      case "--limit":
        parsed.options.limit = parsePosInt(arg, next());
        break;
      case "--host": {
        const v = next();
        if (!HOSTS.includes(v)) throw new UsageError('Unknown --host "' + v + '". Expected one of: ' + HOSTS.join(", ") + ".");
        parsed.host = v;
        break;
      }
      case "--session":
        parsed.options.sessionId = next();
        break;
      case "--include-tool-result":
        parsed.includeToolResult = true;
        break;
      case "--include-thinking":
        parsed.includeThinking = true;
        break;
      case "--pretty":
        parsed.pretty = true;
        break;
      default:
        throw new UsageError("Unknown option \"" + arg + "\".");
    }
  }
  if (parsed.matchFieldSet.size > 0) parsed.options.matchFields = [...parsed.matchFieldSet];
  return parsed;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(usage());
    process.exit(argv.length === 0 ? 2 : 0);
  }
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    process.exit(2);
  }
  if (parsed.id == null && parsed.show !== "titles" && parsed.options.query === "") {
    console.error("No query given.\n\n" + usage());
    process.exit(2);
  }
  const host = parsed.host ?? detectHost();
  if (parsed.id != null) {
    let result;
    try {
      result = await runDrill(parsed.id, parsed.options, host);
    } catch (e) {
      console.error("Recall failed: " + (e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
    if (result && result.error) {
      console.error(result.error);
      process.exit(2);
    }
    if (result == null) {
      console.error("Recall failed: " + 'No turn found for --id "' + parsed.id + '".');
      process.exit(1);
    }
    const out = {
      recallId: result.recallId,
      sessionId: result.sessionId,
      projectPath: result.projectPath,
      timestamp: result.timestamp,
      text: result.text,
      toolCall: result.toolCall,
      ...(parsed.includeToolResult ? { toolResult: result.toolResult } : {}),
      ...(parsed.includeThinking ? { thinking: result.thinking } : {}),
    };
    console.log(parsed.pretty ? JSON.stringify(out, undefined, 2) : JSON.stringify(out));
    process.exit(0);
  }
  if (parsed.options.sinceLastCompactions != null && hostAdapter(host).readCompactionBoundariesMs == null) {
    console.error("--since-last-compactions is unsupported on " + host + ": it records no compaction boundary.");
    process.exit(2);
  }
  if (parsed.options.sessions === "this" && parsed.options.sessionId == null) {
    parsed.options.sessionId = process.env[sessionIdEnv(host)];
  }
  if (parsed.options.sessions === "this" && parsed.options.sessionId == null) {
    console.error("--sessions this needs the current session id, which is only set inside a session. Pass --session <id>, or use --sessions project|all from a bare shell.");
    process.exit(2);
  }
  try {
    if (parsed.show === "titles") {
      const { rows, totalMatched } = await runTitles(parsed.options, host);
      const out = titlesEnvelope(rows, totalMatched, titlesGuidance(parsed.options.sessions, totalMatched), host, parsed.options.sessions);
      console.log(parsed.pretty ? JSON.stringify(out, undefined, 2) : JSON.stringify(out));
    } else {
      const results = await runSearch(parsed.options, host);
      const currentSessionId = process.env[sessionIdEnv(host)];
      const guidance = fullGuidance(parsed.options.query, parsed.options.sessions, results, currentSessionId);
      const out = fullEnvelope(results, guidance, host, parsed.options.sessions, parsed.includeToolResult, parsed.includeThinking);
      console.log(parsed.pretty ? JSON.stringify(out, undefined, 2) : JSON.stringify(out));
    }
    process.exit(0);
  } catch (e) {
    console.error("Recall failed: " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}

export {
  tokenize,
  buildBm25Index,
  bm25fScore,
  termFilter,
  assembleTurns,
  mergeClaudePayloads,
  claudeReadDocuments,
  claudeCompactionBoundariesMs,
  listClaudeSessions,
  resolveClaudeScope,
  windowedReadDocuments,
  hostAdapter,
  parseArgs,
  parseWhen,
  projectSlug,
  runSearch,
  runTitles,
  runDrill,
  recallId,
  parseRecallId,
  outputBudget,
  truncateToUnits,
  fullGuidance,
  titlesGuidance,
  UsageError,
};

export { main as runMain };
