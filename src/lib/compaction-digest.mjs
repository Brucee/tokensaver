// Post-compaction recovery digest.
//
// After Claude Code compacts a session, the summary may lose turns the work
// still needs. This module re-reads the transcript, finds the entries that
// the latest compaction dropped (present before the newest compact_boundary,
// absent from preservedMessages.allUuids), ranks them by BM25 relevance to
// the summary's "where the work was heading" section, discounts whatever
// already survived, and renders a short pointer list the model can expand
// with `recall --id <session>:<turnUuid>`.
//
// Marker lifecycle: the PreCompact hook writes {pendingSinceMs} under
// <home>/post-compaction-digest/<sessionId>.json; the digest is only built
// when a fresh marker exists (TTL 15min) and the marker is always cleared.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { tokensaverHome } from "./config.mjs";
import { tokenize, buildBm25Index, bm25fScore } from "../cli/recall.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const MARKER_TTL_MS = 900_000; // 15min — PostCompact arriving later is stale
const DIGEST_BUDGET = 900; // total chars
const MAX_BULLETS = 5;
const LINE_MAX = 120; // per bullet
const MIN_TOKEN_LEN = 3;
const RETAINED_OVERLAP_PENALTY = 0.6;
const DIRECTION_CAP = 1500;
const DIRECTION_SECTIONS = ["Pending Tasks", "Current Work", "Optional Next Step", "Next Step"];
const BM25F_PARAMS = { k1: 1.2, fields: { text: { boost: 1, b: 0.75 }, toolCall: { boost: 1, b: 0.75 } } };

// Category boosts on top of BM25 — the literature on post-compaction recovery
// ranks unresolved errors and decisions above generic turns (they prevent
// repeat loops), while bare file-touch pointers matter less because Claude
// Code already reattaches recently-read files natively.
const BOOST_ERROR = 1.5;
const BOOST_DECISION = 1.3;
const BOOST_TODO = 1.2;
const BOOST_BARE_POINTER = 0.9;
const DECISION_RE = /\b(decid|decision|scelt|chose|chosen|opted|approach|strategy|trade.?off|instead of|piano)\b/i;
const TODO_RE = /\b(todo|da fare|next step|prossim|pending|rimane|remaining|follow.?up|left to do)\b/i;

const NOISE_SNIPPETS = [
  "task-notification",
  "system-reminder",
  "local-command-caveat",
  "NO LOG:",
  "protocolVersion",
];

// ---------- marker ----------

function markerDir() {
  return path.join(tokensaverHome(), "post-compaction-digest");
}

function markerPath(sessionId) {
  return path.join(markerDir(), `${sessionId}.json`);
}

export function markPendingCompaction(sessionId) {
  fs.mkdirSync(markerDir(), { recursive: true });
  fs.writeFileSync(markerPath(sessionId), JSON.stringify({ pendingSinceMs: Date.now() }), "utf8");
}

export function clearPendingCompaction(sessionId) {
  try {
    fs.unlinkSync(markerPath(sessionId));
  } catch {}
}

function readPendingCompaction(sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(sessionId), "utf8"));
    return typeof parsed?.pendingSinceMs === "number" ? parsed : null;
  } catch {
    return null;
  }
}

// ---------- transcript analysis ----------

async function* readJsonl(filePath) {
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

function isCompactBoundary(e) {
  return e.type === "system" && "subtype" in e && e.subtype === "compact_boundary";
}

function firstLine(s) {
  for (const l of (s ?? "").split("\n")) {
    const t = l.trim();
    if (t) return t;
  }
  return undefined;
}

function truncateLine(s, max) {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

function isNoiseText(s) {
  if (s.startsWith("{") && s.includes("jsonrpc")) return true;
  return NOISE_SNIPPETS.some((n) => s.includes(n));
}

// Deep-first non-empty string inside a tool_use input (file_path, command, …).
function firstStringValue(v) {
  if (typeof v === "string") return v.trim() === "" ? undefined : v;
  if (Array.isArray(v)) {
    for (const item of v) {
      const found = firstStringValue(item);
      if (found != null) return found;
    }
    return undefined;
  }
  if (v != null && typeof v === "object") {
    for (const item of Object.values(v)) {
      const found = firstStringValue(item);
      if (found != null) return found;
    }
  }
  return undefined;
}

// "Edit: C:\path\file.py" — first tool_use name + its leading arg string.
function toolPointerOf(message) {
  if (typeof message?.content === "string") return undefined;
  for (const block of message?.content ?? []) {
    if (block.type !== "tool_use") continue;
    const arg = firstStringValue(block.input);
    return arg == null ? block.name : `${block.name}: ${arg}`;
  }
  return undefined;
}

function userMessageHasContent(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content.length > 0 && !(content.startsWith("{") || content.startsWith("[") || isNoiseText(content));
  }
  for (const block of content ?? []) {
    if (block.type === "text" && block.text.length > 0 && !isNoiseText(block.text)) return true;
  }
  return false;
}

// {text, toolCall, error} fields of one message — error tool_results and
// shadowed tool_use are dropped from the indexed text (same rules as the
// recall engine) but flagged, because an unresolved error is exactly what
// the digest should surface.
function fieldsOfMessage(message, failedIds) {
  const content = message?.content;
  if (typeof content === "string") return { text: content, toolCall: "", error: false };
  const text = [];
  const toolCall = [];
  let error = false;
  for (const block of content ?? []) {
    if (block.type === "tool_result" && block.is_error === true) {
      error = true;
      failedIds?.add(block.tool_use_id);
      continue;
    }
    if (block.type === "text") text.push(block.text);
    else if (block.type === "tool_use" && !failedIds?.has(block.id)) {
      toolCall.push(block.name + " " + JSON.stringify(block.input));
    }
  }
  return { text: text.join("\n"), toolCall: toolCall.join("\n"), error };
}

function tokensOf(fields) {
  return tokenize(`${fields.text} ${fields.toolCall}`).filter((t) => t.length >= MIN_TOKEN_LEN);
}

// First section heading onward, capped — the summary's "where we were going".
function directionFromSummary(summary) {
  let idx = -1;
  for (const h of DIRECTION_SECTIONS) {
    const i = summary.indexOf(h);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  return idx === -1 ? "" : summary.slice(idx, idx + DIRECTION_CAP);
}

async function analyzeTranscript(transcriptPath) {
  const entries = [];
  const failedIds = new Set();
  let order = 0;
  let prevBoundary = -1;
  let lastBoundary = -1;
  let preservedAt = -1;
  let preserved;
  let summary = "";
  let lastRetainedLine = "";
  let turnAnchor;

  for await (const e of readJsonl(transcriptPath)) {
    if (isCompactBoundary(e)) {
      prevBoundary = lastBoundary;
      lastBoundary = order;
      const uuids = e.compactMetadata?.preservedMessages?.allUuids;
      if (uuids != null) {
        preservedAt = order;
        preserved = new Set(uuids);
      }
      order++;
      continue;
    }
    if (e.type === "user" && e.isCompactSummary === true) {
      summary = fieldsOfMessage(e.message, failedIds).text;
      order++;
      continue;
    }
    if (e.type === "user" || e.type === "assistant") {
      if (e.type === "user" && userMessageHasContent(e.message)) turnAnchor = e.uuid;
      const fields = fieldsOfMessage(e.message, failedIds);
      // The tool_result error lands on the user entry — attribute it back to
      // the calling assistant entry so the boost hits the rankable document.
      if (fields.error && entries.length > 0) entries[entries.length - 1].fields.error = true;
      entries.push({
        uuid: e.uuid,
        turnAnchorUuid: turnAnchor ?? e.uuid,
        fields,
        toolPointer: toolPointerOf(e.message),
        order,
      });
    }
    order++;
  }

  if (lastBoundary === -1 || lastBoundary > preservedAt) {
    return { droppedTurns: [], retainedTokens: new Set(), directionQuery: "", boundaryFound: false, preservedFound: false };
  }
  if (preserved == null) {
    return { droppedTurns: [], retainedTokens: new Set(), directionQuery: "", boundaryFound: true, preservedFound: false };
  }

  const dropped = [];
  const retainedTokens = new Set();
  for (const entry of entries) {
    if (preserved.has(entry.uuid)) {
      for (const t of tokensOf(entry.fields)) retainedTokens.add(t);
      const line = firstLine(entry.fields.text);
      if (line != null) lastRetainedLine = line;
      continue;
    }
    if (entry.order > prevBoundary && entry.order < preservedAt && (entry.fields.text !== "" || entry.fields.toolCall !== "")) {
      dropped.push(entry);
    }
  }
  return {
    droppedTurns: dropped,
    retainedTokens,
    directionQuery: directionFromSummary(summary) || lastRetainedLine || summary,
    boundaryFound: true,
    preservedFound: true,
  };
}

// BM25 against the direction query; skip turns fully covered by the query;
// discount turns overlapping what compaction retained. Exported for tests.
export function rankDroppedTurns(analysis) {
  const byUuid = new Map();
  const docs = [];
  for (const turn of analysis.droppedTurns) {
    byUuid.set(turn.uuid, turn);
    docs.push({ key: turn.uuid, fields: { text: turn.fields.text, toolCall: turn.fields.toolCall } });
  }
  if (docs.length === 0) return [];
  const index = buildBm25Index(docs, BM25F_PARAMS);
  const scored = bm25fScore(index, analysis.directionQuery, BM25F_PARAMS);
  const directionTokens = new Set(tokenize(analysis.directionQuery).filter((t) => t.length >= MIN_TOKEN_LEN));
  const ranked = [];
  for (const { key, score } of scored) {
    const turn = byUuid.get(key);
    if (turn == null) continue;
    const toks = tokensOf(turn.fields);
    if (toks.length > 0 && toks.every((t) => directionTokens.has(t))) continue;
    const overlap = toks.length === 0 ? 0 : toks.filter((t) => analysis.retainedTokens.has(t)).length / toks.length;
    ranked.push({ turn, score: score * (1 - RETAINED_OVERLAP_PENALTY * overlap) * categoryBoost(turn) });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.map((r) => r.turn);
}

// Highest-priority matching category wins: unresolved error > decision >
// open task > bare file pointer (demoted — natively reattached anyway).
function categoryBoost(turn) {
  if (turn.fields.error) return BOOST_ERROR;
  if (DECISION_RE.test(turn.fields.text)) return BOOST_DECISION;
  if (TODO_RE.test(turn.fields.text)) return BOOST_TODO;
  if (turn.fields.text.trim() === "" && turn.toolPointer != null) return BOOST_BARE_POINTER;
  return 1;
}

function bulletLine(turn) {
  const pointer = turn.toolPointer != null ? firstLine(turn.toolPointer) : undefined;
  const source = pointer ?? firstLine(turn.fields.text);
  return source == null ? null : truncateLine(source, LINE_MAX);
}

function formatDigest(sessionId, turns, hostName) {
  // Claude has the recall subagent; on other hosts point at the CLI directly.
  const expand =
    hostName === "codex"
      ? `run \`node "${path.join(PLUGIN_ROOT, "scripts", "recall.cjs")}" --id ${sessionId}:<id>\` to expand any item`
      : `ask the recall subagent to expand any item — \`recall --id ${sessionId}:<id>\``;
  const header = `Recovered from before the last compaction (${expand}):`;
  const bullets = [];
  const seenAnchors = new Set();
  let used = header.length;
  for (const turn of turns) {
    // One bullet per turn — the recall id expands to the whole turn anyway,
    // so same-anchor repeats would only steal slots from other turns.
    if (seenAnchors.has(turn.turnAnchorUuid)) continue;
    seenAnchors.add(turn.turnAnchorUuid);
    const line = bulletLine(turn);
    if (line == null) continue;
    const bullet = `- ${line} [id: ${turn.turnAnchorUuid}]`;
    if (used + bullet.length + 1 > DIGEST_BUDGET) break;
    bullets.push(bullet);
    used += bullet.length + 1;
    if (bullets.length >= MAX_BULLETS) break;
  }
  return bullets.length === 0 ? undefined : `${header}\n${bullets.join("\n")}`;
}

// ---------- codex rollout variant ----------
// Codex records compactions as top-level {type:"compacted"} lines whose
// payload.replacement_history is the plaintext list of context items kept —
// the direct analogue of Claude's preservedMessages.allUuids. The encrypted
// response_item/compaction summary is unreadable, so the direction query
// falls back to the text the compaction itself retained.
const CODEX_CALL_TYPES = new Set(["function_call", "local_shell_call", "custom_tool_call"]);
const CODEX_FAILED_STATUS = new Set(["failed", "declined", "error", "cancelled"]);
const CODEX_NOISE_PREFIXES = ["<environment_context>", "<permissions instructions>"];

function codexItemText(item) {
  if (item?.type !== "message") return undefined;
  const text = (item.content ?? []).map((c) => c.text ?? "").join("\n").trim();
  if (text === "" || CODEX_NOISE_PREFIXES.some((p) => text.startsWith(p))) return undefined;
  return text;
}

function codexToolPointerOf(p) {
  const raw = typeof p?.input === "string" ? p.input : (typeof p?.input?.text === "string" ? p.input.text : "");
  const input = raw.replace(/\\n/g, "\n"); // rollout stores JS with escaped newlines
  if (p?.name === "exec" && input !== "") {
    const patched = input.match(/\*\*\* Update File:\s*(\S+)/);
    if (patched) return `exec: apply_patch ${patched[1]}`;
    const names = [...input.matchAll(/\btools\.(\w+)\s*\(/g)].map((m) => m[1]);
    if (names.length > 0) return `exec: ${[...new Set(names)].join(", ")}`;
  }
  const arg = firstStringValue(p?.arguments ?? p?.input);
  return arg == null ? p?.name : `${p?.name}: ${arg}`;
}

// Map one response_item payload to a digest entry (same shape as Claude's).
function codexEntryOf(p, order, turnAnchor) {
  const uuid = p?.id;
  if (uuid == null) return undefined;
  const fields = { text: "", toolCall: "", error: false };
  let toolPointer;
  if (p.type === "message") {
    if (p.role === "developer") return undefined;
    const text = codexItemText(p);
    if (text == null) return p.role === "user" ? { uuid, turnAnchorUuid: turnAnchor ?? uuid, fields, order } : undefined;
    fields.text = text;
  } else if (CODEX_CALL_TYPES.has(p.type)) {
    fields.toolCall = `${p.name ?? "tool"} ${JSON.stringify(p.arguments ?? p.input ?? "")}`;
    fields.error = CODEX_FAILED_STATUS.has(p.status);
    toolPointer = codexToolPointerOf(p);
  } else {
    return undefined; // outputs, reasoning, compaction items carry no rankable text
  }
  return { uuid, turnAnchorUuid: turnAnchor ?? uuid, fields, toolPointer, order };
}

async function analyzeCodexTranscript(transcriptPath) {
  const entries = [];
  let order = 0;
  let prevBoundary = -1;
  let lastBoundary = -1;
  let preservedAt = -1;
  let preserved;
  let directionText = "";
  let turnAnchor;

  for await (const e of readJsonl(transcriptPath)) {
    if (e.type === "compacted") {
      prevBoundary = lastBoundary;
      lastBoundary = order;
      const hist = e.payload?.replacement_history;
      if (Array.isArray(hist)) {
        preservedAt = order;
        preserved = new Set(hist.map((it) => it?.id).filter(Boolean));
        for (const it of hist) {
          const t = codexItemText(it);
          if (t != null) directionText = t; // last retained text = direction
        }
      }
      order++;
      continue;
    }
    if (e.type === "turn_context" && typeof e.payload?.turn_id === "string") {
      turnAnchor = e.payload.turn_id;
    }
    if (e.type === "response_item") {
      const p = e.payload ?? {};
      const tid = p.internal_chat_message_metadata_passthrough?.turn_id;
      if (typeof tid === "string") turnAnchor = tid;
      const entry = codexEntryOf(p, order, turnAnchor);
      if (entry != null) entries.push(entry);
    }
    order++;
  }

  if (lastBoundary === -1 || lastBoundary > preservedAt) {
    return { droppedTurns: [], retainedTokens: new Set(), directionQuery: "", boundaryFound: false, preservedFound: false };
  }
  if (preserved == null) {
    return { droppedTurns: [], retainedTokens: new Set(), directionQuery: "", boundaryFound: true, preservedFound: false };
  }
  const dropped = [];
  const retainedTokens = new Set();
  for (const entry of entries) {
    if (preserved.has(entry.uuid)) {
      for (const t of tokensOf(entry.fields)) retainedTokens.add(t);
      continue;
    }
    if (entry.order > prevBoundary && entry.order < preservedAt && (entry.fields.text !== "" || entry.fields.toolCall !== "")) {
      dropped.push(entry);
    }
  }
  return {
    droppedTurns: dropped,
    retainedTokens,
    directionQuery: directionText,
    boundaryFound: true,
    preservedFound: true,
  };
}

export async function buildPostCompactionDigest(sessionId, transcriptPath, hostName) {
  const marker = readPendingCompaction(sessionId);
  if (marker == null) {
    clearPendingCompaction(sessionId);
    return undefined;
  }
  if (Date.now() - marker.pendingSinceMs > MARKER_TTL_MS) {
    clearPendingCompaction(sessionId);
    return undefined;
  }
  const analyze = hostName === "codex" ? analyzeCodexTranscript : analyzeTranscript;
  const analysis = await analyze(transcriptPath);
  if (!analysis.boundaryFound) return undefined; // keep marker — boundary may not be flushed yet
  clearPendingCompaction(sessionId);
  if (!analysis.preservedFound || analysis.droppedTurns.length === 0) return undefined;
  return formatDigest(sessionId, rankDroppedTurns(analysis), hostName);
}
