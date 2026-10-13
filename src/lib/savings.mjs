// Savings engine: incremental transcript scanner + session-state persistence.
// Estimates the "native calls" each tokenSaver MCP call replaces, then converts
// saved calls into time/tokens/cost using the session's average per-turn usage.
import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tokensaverHome, ensureHome, writeJsonAtomic } from "./config.mjs";

// ---------- pricing ----------

function std(inputPerMillion, outputPerMillion) {
  return {
    inputPerMillion,
    cacheReadPerMillion: inputPerMillion * 0.1,
    cacheWritePerMillion: inputPerMillion * 1.25,
    outputPerMillion,
  };
}

function tiered(input, output, thresholdTokens, longInput, longOutput) {
  return {
    ...std(input, output),
    longContext: {
      thresholdTokens,
      inputPerMillion: longInput,
      cacheReadPerMillion: longInput * 0.1,
      cacheWritePerMillion: longInput * 1.25,
      outputPerMillion: longOutput,
    },
  };
}

// Anthropic rates (Oct 2026). New 5.x models price cache reads at 5% of input
// (2.5% on Fable/Mythos), so they carry explicit rows instead of std().
const PRICING = {
  "claude-fable-5": { inputPerMillion: 10, cacheReadPerMillion: 0.25, cacheWritePerMillion: 12.5, outputPerMillion: 50 },
  "claude-mythos-5": { inputPerMillion: 10, cacheReadPerMillion: 0.25, cacheWritePerMillion: 12.5, outputPerMillion: 50 },
  "claude-opus-5-5": { inputPerMillion: 4, cacheReadPerMillion: 0.2, cacheWritePerMillion: 5, outputPerMillion: 20 },
  "claude-opus-5": std(5, 25),
  "claude-opus-4-8": std(5, 25),
  "claude-opus-4-7": std(5, 25),
  "claude-opus-4-6": std(5, 25),
  "claude-opus-4-5": std(5, 25),
  "claude-opus-4-0": std(15, 75),
  "claude-sonnet-5-5": { inputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 2.5, outputPerMillion: 10 },
  "claude-sonnet-5": { inputPerMillion: 2, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5, outputPerMillion: 10 },
  "claude-sonnet-4-6": std(3, 15),
  "claude-sonnet-4-5": std(3, 15),
  "claude-sonnet-4-0": std(3, 15),
  "claude-haiku-5-5": tiered(0.1, 0.5, 100000, 0.5, 2.5),
  "claude-haiku-4-5": std(1, 5),
  "claude-haiku-3-5": std(0.8, 4),
  fable: { inputPerMillion: 10, cacheReadPerMillion: 0.25, cacheWritePerMillion: 12.5, outputPerMillion: 50 },
  opus: { inputPerMillion: 4, cacheReadPerMillion: 0.2, cacheWritePerMillion: 5, outputPerMillion: 20 },
  sonnet: { inputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 2.5, outputPerMillion: 10 },
  haiku: tiered(0.1, 0.5, 100000, 0.5, 2.5),
  "composer-2-fast": { inputPerMillion: 1.5, cacheReadPerMillion: 0.35, cacheWritePerMillion: 1.5, outputPerMillion: 7.5 },
  "composer 2 fast": { inputPerMillion: 1.5, cacheReadPerMillion: 0.35, cacheWritePerMillion: 1.5, outputPerMillion: 7.5 },
  "composer-2": { inputPerMillion: 0.5, cacheReadPerMillion: 0.2, cacheWritePerMillion: 0.5, outputPerMillion: 2.5 },
  "composer 2": { inputPerMillion: 0.5, cacheReadPerMillion: 0.2, cacheWritePerMillion: 0.5, outputPerMillion: 2.5 },
  "composer-1.5": std(3.5, 17.5),
  "composer 1.5": std(3.5, 17.5),
  "gpt-5-mini": std(0.25, 2),
  "gpt-5-nano": std(0.05, 0.4),
  "gpt-5": std(1.25, 10),
  "gpt-5.5": tiered(5, 30, 272000, 10, 45),
  "gpt-5.4": tiered(2.5, 15, 272000, 5, 22.5),
  "gpt-5.4-mini": std(0.75, 4.5),
  "gpt-5.4-nano": std(0.2, 1.25),
  "gpt-5.3-codex": std(1.25, 10),
  "gpt-5.6-sol": tiered(5, 30, 272000, 10, 45),
  "gpt-5.6-terra": tiered(2.5, 15, 272000, 5, 22.5),
  "gpt-5.6-luna": tiered(1, 6, 272000, 2, 9),
  "kimi-k3": std(3, 15),
  "muse-spark-1.1": std(1.25, 4.25),
};

const FALLBACK_PRICING = std(3, 15);
const PRICING_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);

// Boundary-aware substring match: the key may only be flanked by
// /, :, ., -, [ (or string edges) so "sonnet" doesn't match "sonnette-x".
function boundedContains(haystack, needle) {
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx < 0) return false;
    const before = idx === 0 ? "" : haystack[idx - 1];
    const end = idx + needle.length;
    const after = end >= haystack.length ? "" : haystack[end];
    const okBefore = before === "" || before === "/" || before === ":" || before === ".";
    const okAfter = after === "" || after === "-" || after === "/" || after === ":" || after === "[";
    if (okBefore && okAfter) return true;
    idx++;
  }
}

export function pricingFor(model) {
  if (model == null) return FALLBACK_PRICING;
  const lower = model.toLowerCase();
  if (Object.hasOwn(PRICING, lower)) return PRICING[lower];
  for (const key of PRICING_KEYS) {
    if (boundedContains(lower, key)) return PRICING[key];
  }
  return FALLBACK_PRICING;
}

export function resolveModelKey(model) {
  const lower = model.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const tail = slash < 0 ? lower : lower.slice(slash + 1);
  if (Object.hasOwn(PRICING, tail)) return tail;
  for (const key of PRICING_KEYS) {
    if (boundedContains(tail, key)) return key;
  }
  return tail;
}

// Cost of a usage block under a model's pricing, applying the long-context
// tier when the average context-per-turn exceeds the threshold.
export function costOf(usage, model, forcedPricing) {
  if (forcedPricing != null) return forcedPricing;
  const base = pricingFor(model);
  const context = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const perTurn = context / Math.max(1, usage.turnCount);
  const rate = base.longContext != null && perTurn > base.longContext.thresholdTokens ? base.longContext : base;
  return (
    (usage.inputTokens * rate.inputPerMillion) / 1e6 +
    (usage.outputTokens * rate.outputPerMillion) / 1e6 +
    (usage.cacheReadTokens * rate.cacheReadPerMillion) / 1e6 +
    (usage.cacheCreationTokens * rate.cacheWritePerMillion) / 1e6
  );
}

// ---------- equivalent-call weights ----------

// Our MCP server registers under different ids per host: the plugin-qualified
// name on Claude, plain "code" on Codex. Both prefixes identify our tools in
// transcripts; host-specific detection inside exec JS uses the codex prefix.
const OWN_PREFIXES = ["mcp__plugin_tokensaver_code__", "mcp__code__"];
const TIME_SAVED_PER_CALL_MS = 25000;
const TOKEN_MULTIPLIER = 1.3;

function ownToolKind(name) {
  for (const prefix of OWN_PREFIXES) {
    if (name.startsWith(prefix)) {
      const kind = name.slice(prefix.length);
      return kind === "Search" || kind === "Edit" || kind === "Sql" ? kind : "other";
    }
  }
  return undefined;
}

// How many separate native tool calls one of our MCP calls would have needed.
export function equivalentCallsFor(name, input) {
  const kind = ownToolKind(name);
  if (kind === undefined) return 0;
  if (kind === "Edit") {
    const edits = Array.isArray(input?.edits) ? input.edits : [];
    const files = new Set(edits.map((e) => e.file_path).filter(Boolean)).size;
    return Math.max(edits.length, 1) + (files || 1) + 0.5;
  }
  if (kind === "Search") {
    let n = 2;
    const globs = Array.isArray(input?.file_glob_patterns) ? input.file_glob_patterns.length : 0;
    if (globs > 1) n += globs - 1;
    if (input?.content_regex != null) n += 1;
    if (input?.summary === true || input?.type === "summary") n += 1;
    return n;
  }
  if (kind === "Sql") return 5;
  return 1;
}

// Savings produced by `calls` avoided calls at the session's per-turn averages.
export function savingsFor(calls, avgInput, avgCacheRead, avgCacheCreate, avgOutput, model) {
  const saved = Math.max(calls - 1, 0);
  const rate = pricingFor(model);
  const inTok = Math.round(saved * avgInput * TOKEN_MULTIPLIER);
  const crTok = Math.round(saved * avgCacheRead * TOKEN_MULTIPLIER);
  const ccTok = Math.round(saved * avgCacheCreate * TOKEN_MULTIPLIER);
  const outTok = Math.round(saved * avgOutput);
  return {
    callsSaved: saved,
    timeSavedInMs: saved * TIME_SAVED_PER_CALL_MS,
    tokensSaved: inTok + crTok + ccTok + outTok,
    costSavedInUsd:
      (inTok / 1e6) * rate.inputPerMillion +
      (crTok / 1e6) * rate.cacheReadPerMillion +
      (ccTok / 1e6) * rate.cacheWritePerMillion +
      (outTok / 1e6) * rate.outputPerMillion,
  };
}

// ---------- session state ----------

const SESSION_STATE_VERSION = 1;
const SESSION_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.json$/;

function emptyUsage() {
  return {
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputThinkingTokens: 0,
    toolUseCount: 0,
    costInUsd: 0,
  };
}

function emptySavings() {
  return { callsSaved: 0, timeSavedInMs: 0, tokensSaved: 0, costSavedInUsd: 0 };
}

function emptyDailyEntry() {
  return { ...emptySavings(), toolCallCount: 0, costInUsd: 0 };
}

function emptySlice() {
  return {
    usage: emptyUsage(),
    byteOffset: 0,
    pendingEquivalentSum: 0,
    pendingCallCount: 0,
    // tool-call-key → equivalent-call weight for saver calls whose result
    // record has not been scanned yet (hooks fire between call and output).
    pendingSaverCalls: {},
    saverCalls: 0,
    equivalentNativeToolCalls: 0,
    savings: emptySavings(),
    dailySavings: {},
  };
}

function emptySessionState() {
  return {
    version: SESSION_STATE_VERSION,
    parent: emptySlice(),
    usage: emptyUsage(),
    prevUsage: emptyUsage(),
    totalSaverCalls: 0,
    equivalentNativeToolCalls: 0,
    accumulatedSavings: emptySavings(),
    dailySavings: {},
    compactions: { countAuto: 0, countManual: 0, timeSpentCompactingInMs: 0 },
    subagents: Object.create(null),
    codeEditLines: { linesAdded: 0, linesRemoved: 0, editsApplied: 0 },
  };
}

function normalizeSlice(raw) {
  return { ...emptySlice(), ...raw, usage: { ...emptyUsage(), ...raw?.usage }, savings: { ...emptySavings(), ...raw?.savings }, dailySavings: raw?.dailySavings ?? {} };
}

function normalizeState(raw) {
  const base = emptySessionState();
  if (raw == null || typeof raw !== "object") return base;
  // Null-prototype map: agent ids are host-supplied strings and keys like
  // "__proto__"/"toString" must not hit Object.prototype.
  const subagents = Object.create(null);
  for (const [id, slice] of Object.entries(raw.subagents ?? {})) subagents[id] = normalizeSlice(slice);
  const state = {
    ...base,
    ...raw,
    version: SESSION_STATE_VERSION,
    parent: normalizeSlice(raw.parent),
    subagents,
    prevUsage: { ...base.prevUsage, ...raw.prevUsage },
    compactions: { ...base.compactions, ...raw.compactions },
    codeEditLines: { ...base.codeEditLines, ...raw.codeEditLines },
    usage: emptyUsage(),
    accumulatedSavings: emptySavings(),
    dailySavings: {},
    totalSaverCalls: 0,
    equivalentNativeToolCalls: 0,
  };
  rollup(state);
  return state;
}

function addUsageInto(dst, src) {
  for (const k of Object.keys(emptyUsage())) dst[k] = (dst[k] ?? 0) + (src[k] ?? 0);
}

function addSavingsInto(dst, src) {
  for (const k of Object.keys(emptySavings())) dst[k] = (dst[k] ?? 0) + (src[k] ?? 0);
}

function rollup(state) {
  const usage = emptyUsage();
  const savings = emptySavings();
  const daily = {};
  let saverCalls = 0;
  let equiv = 0;
  let model = state.parent.model;
  for (const slice of [state.parent, ...Object.values(state.subagents)]) {
    addUsageInto(usage, slice.usage);
    addSavingsInto(savings, slice.savings);
    saverCalls += slice.saverCalls;
    equiv += slice.equivalentNativeToolCalls;
    for (const [date, entry] of Object.entries(slice.dailySavings)) {
      const agg = (daily[date] ??= emptyDailyEntry());
      addSavingsInto(agg, entry);
      agg.toolCallCount += entry.toolCallCount;
      agg.costInUsd += entry.costInUsd;
    }
    if (slice.model != null) model = slice.model;
  }
  state.usage = usage;
  state.accumulatedSavings = savings;
  state.dailySavings = daily;
  state.totalSaverCalls = saverCalls;
  state.equivalentNativeToolCalls = equiv;
  state.model = model;
}

function todayKey() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function addCostToDaily(slice, cost) {
  if (!Number.isFinite(cost) || cost <= 0) return;
  const entry = (slice.dailySavings[todayKey()] ??= emptyDailyEntry());
  entry.costInUsd += cost;
}

// Convert a batch of our MCP calls into savings at current per-turn averages.
function recordCallSavings(slice, equivalentSum, callCount, model) {
  if (callCount === 0) return;
  const calls = Math.max(equivalentSum - callCount, 0) + 1;
  const { turnCount } = slice.usage;
  if (turnCount <= 0) return;
  const result = savingsFor(
    calls,
    slice.usage.inputTokens / turnCount,
    slice.usage.cacheReadTokens / turnCount,
    slice.usage.cacheCreationTokens / turnCount,
    slice.usage.outputTokens / turnCount,
    model
  );
  addSavingsInto(slice.savings, result);
  const daily = (slice.dailySavings[todayKey()] ??= emptyDailyEntry());
  addSavingsInto(daily, result);
  daily.toolCallCount += callCount;
}

// ---------- transcript scanning ----------

const OVERLOAD_STATUS = 529;
const OVERLOAD_TYPE = "overloaded_error";

function emptyScan() {
  return {
    usage: emptyUsage(),
    usageByModel: Object.create(null),
    saverCalls: 0,
    equivalentNativeToolCalls: 0,
    model: undefined,
    lastStopReason: undefined,
    maxSeenRequestId: undefined,
    spawnedSubagent: false,
    turnDurationMs: 0,
    sawApiError: false,
    endedInError: false,
    endedInOverload: false,
    sawOverload: false,
    serviceTier: undefined,
    codeEditLines: { linesAdded: 0, linesRemoved: 0, editsApplied: 0 },
  };
}

function modelBucket(scan, model) {
  return (scan.usageByModel[model] ??= emptyUsage());
}

// Edited-line counter for the Edit tool's old/new strings.
const lc = (s) => (typeof s === "string" && s !== "" ? s.replace(/\n$/, "").split("\n").length : 0);

function usageFromMessage(u) {
  return {
    turnCount: 0,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    outputThinkingTokens: u.output_tokens_details?.thinking_tokens ?? 0,
    toolUseCount: 0,
    costInUsd: 0,
  };
}

// Read only the delta as bytes — fromOffset is a byte offset (statSync.size),
// so slicing a decoded string would misalign on non-ASCII content. Holds back
// a trailing partial line unless it already parses as JSON — the next scan
// picks it up once the writer finishes it. Shared by both host scanners.
function readDeltaSlice(path, fromOffset, size) {
  const fd = openSync(path, "r");
  let buf;
  try {
    buf = Buffer.alloc(size - fromOffset);
    readSync(fd, buf, 0, size - fromOffset, fromOffset);
  } finally {
    closeSync(fd);
  }
  let end = buf.length;
  if (end > 0 && buf[end - 1] !== 0x0a) {
    const lastNl = buf.lastIndexOf(0x0a);
    const tail = buf.subarray(lastNl + 1).toString("utf8");
    try {
      JSON.parse(tail);
    } catch {
      end = lastNl + 1;
    }
  }
  return { text: buf.subarray(0, end).toString("utf8"), byteOffset: fromOffset + end };
}

// Parse the transcript delta from `fromOffset`. `highWater` is the last
// requestId already counted; messages at or below it are skipped for usage.
// `pendingSaver` pairs tool calls with their results across scan boundaries:
// hooks fire between the call record and its output record, so the map must
// outlive a single scan (the caller persists it in session state).
export function scanTranscriptDelta(path, fromOffset, highWater, pendingSaver = new Map()) {
  const scan = emptyScan();
  const size = statSync(path).size;
  if (size <= fromOffset) return { scan, byteOffset: fromOffset };
  let warnedOutOfOrder = false;
  scan.maxSeenRequestId = highWater;
  const seenToolUse = new Set();
  const { text: slice, byteOffset } = readDeltaSlice(path, fromOffset, size);
  for (const line of slice.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.type === "system") {
      if (rec.subtype === "turn_duration") scan.turnDurationMs += rec.durationMs ?? 0;
      else if (rec.subtype === "api_error") {
        const overloaded = rec.error?.status === OVERLOAD_STATUS || rec.error?.type === OVERLOAD_TYPE;
        scan.sawApiError = true;
        scan.endedInError = true;
        scan.endedInOverload = overloaded;
        if (overloaded) scan.sawOverload = true;
      }
      continue;
    }
    if (rec.type === "user") {
      const content = rec.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const equiv = pendingSaver.get(block.tool_use_id);
          if (equiv != null) {
            pendingSaver.delete(block.tool_use_id);
            if (block.is_error !== true) {
              scan.saverCalls++;
              scan.equivalentNativeToolCalls += equiv;
            }
          }
        }
      }
      continue;
    }
    if (rec.type !== "assistant") continue;
    if (rec.isApiErrorMessage === true) {
      scan.sawApiError = true;
      scan.endedInError = true;
      continue;
    }
    const message = rec.message;
    if (message == null) continue;
    const requestId = rec.requestId;
    const model = typeof message.model === "string" ? message.model : "unknown";
    // Tool calls are counted even for already-seen requestIds (each id is
    // dedup'd individually), but only when the requestId is newer than the
    // persisted high-water mark.
    if (requestId == null || highWater == null || !(requestId <= highWater)) {
      for (const block of message.content ?? []) {
        if ((block.type === "tool_use" || block.type === "mcp_tool_use") && !seenToolUse.has(block.id)) {
          seenToolUse.add(block.id);
          const bucket = modelBucket(scan, model);
          scan.usage.toolUseCount++;
          bucket.toolUseCount++;
          if (block.name === "Task" || block.name === "Agent") scan.spawnedSubagent = true;
          const equiv = equivalentCallsFor(block.name, block.input);
          if (equiv > 0) pendingSaver.set(block.id, equiv);
          if (ownToolKind(block.name) === "Edit" && Array.isArray(block.input?.edits)) {
            for (const e of block.input.edits) {
              scan.codeEditLines.linesAdded += lc(e?.new_string);
              scan.codeEditLines.linesRemoved += lc(e?.old_string);
              scan.codeEditLines.editsApplied++;
            }
          }
        }
      }
    }
    if (message.stop_reason == null) continue;
    let alreadyCounted = false;
    if (requestId != null) {
      if (scan.maxSeenRequestId != null && requestId <= scan.maxSeenRequestId) {
        if (highWater != null && requestId <= highWater) continue;
        alreadyCounted = true;
      } else {
        if (!warnedOutOfOrder && highWater != null && requestId < highWater) {
          process.stderr.write(`[tokensaver] out-of-order requestId in ${path}: ${requestId} < ${highWater}. High-water-mark dedup may undercount.\n`);
          warnedOutOfOrder = true;
        }
        scan.maxSeenRequestId = requestId;
      }
    }
    const bucket = modelBucket(scan, model);
    if (alreadyCounted) continue;
    scan.usage.turnCount++;
    bucket.turnCount++;
    scan.endedInError = false;
    scan.endedInOverload = false;
    const usage = message.usage;
    if (usage == null) continue;
    if (typeof message.model === "string") scan.model = message.model;
    scan.lastStopReason = message.stop_reason;
    const turnUsage = usageFromMessage(usage);
    addUsageInto(scan.usage, turnUsage);
    addUsageInto(bucket, turnUsage);
    if (typeof message.model === "string") {
      const cost = costOf({ ...turnUsage, turnCount: 1 }, message.model);
      scan.usage.costInUsd += cost;
      bucket.costInUsd += cost;
    }
    if (scan.serviceTier == null) {
      const tier = usage.service_tier;
      if (tier === null) scan.serviceTier = "unknown";
      else if (tier === "standard") scan.serviceTier = "standard";
    }
  }
  return { scan, byteOffset };
}

// ---------- codex rollout scanning ----------
// Codex persists sessions as rollout-*.jsonl records {timestamp, ordinal,
// type, payload} (~/.codex/sessions/<y>/<m>/<d>/). Per-response usage lives on
// `token_usage_record` (payload.usage is per API call; turn_token_usage is the
// cumulative variant we deliberately ignore). Tool calls are `response_item`
// payloads of function_call/local_shell_call/custom_tool_call type; our MCP
// calls reach the transcript as JS inside `custom_tool_call` name "exec"
// (`await tools.mcp__code__Search({...})`) — direct mcp__code__ names are
// handled too since other Codex surfaces may emit them verbatim.
const CODEX_CALL_TYPES = new Set(["function_call", "local_shell_call", "custom_tool_call"]);
const CODEX_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const CODEX_FAILED_STATUS = new Set(["failed", "declined", "error", "cancelled"]);
const RE_TOOLS_CALL = /tools\.(mcp__code__\w+)\s*\(/g;

// First balanced (...) starting at openIndex, quote/escape aware.
function jsArgText(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      for (i++; i < source.length && source[i] !== q; i++) {
        if (source[i] === "\\") i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return undefined;
}

// Model-emitted args are JS literals (unquoted keys, single-quoted strings).
// Normalize to JSON and parse; unparseable input degrades to {} rather than
// dropping the call.
function parseJsArgs(expr) {
  const trimmed = (expr ?? "").trim();
  if (!trimmed.startsWith("{")) return {};
  const normalized = trimmed.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  const variants = [
    normalized,
    // Second chance: JS single-quoted strings → JSON double-quoted.
    normalized.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner) =>
      '"' + inner.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"'
    ),
  ];
  for (const variant of variants) {
    try {
      const v = JSON.parse(variant);
      if (v != null && typeof v === "object") return v;
    } catch {}
  }
  return {};
}

// Every saver invocation inside a codex call payload: direct mcp__code__Xxx
// names, plus tools.mcp__code__Xxx(...) calls embedded in `exec` JS source.
function codexSaverCalls(payload) {
  const name = typeof payload?.name === "string" ? payload.name : "";
  if (ownToolKind(name) !== undefined) {
    let input = {};
    try {
      input = JSON.parse(payload.arguments ?? "{}");
    } catch {}
    return [{ name, input }];
  }
  if (name !== "exec" || typeof payload.input !== "string") return [];
  const out = [];
  for (const m of payload.input.matchAll(RE_TOOLS_CALL)) {
    out.push({ name: m[1], input: parseJsArgs(jsArgText(payload.input, m.index + m[0].length - 1)) });
  }
  return out;
}

// Exec output can contain several serialized MCP results. If any fails,
// withhold credit for the wrapper: the rollout has no reliable per-call
// success mapping. Direct MCP output is handled by the same parser.
function codexOutputFailed(output, depth = 0) {
  if (depth > 12) return true;
  if (typeof output === "string") {
    try { return codexOutputFailed(JSON.parse(output), depth + 1); } catch {}
    return /["'](?:isError|is_error)["']\s*:\s*true/.test(output);
  }
  if (Array.isArray(output)) return output.some((item) => codexOutputFailed(item, depth + 1));
  if (output && typeof output === "object") {
    if (output.isError === true || output.is_error === true || CODEX_FAILED_STATUS.has(output.status)) return true;
    return Object.values(output).some((value) => codexOutputFailed(value, depth + 1));
  }
  return false;
}

export function scanCodexTranscriptDelta(path, fromOffset, highWater, pendingSaver = new Map(), priorModel) {
  const scan = emptyScan();
  const size = statSync(path).size;
  if (size <= fromOffset) return { scan, byteOffset: fromOffset };
  scan.maxSeenRequestId = highWater;
  const { text: slice, byteOffset } = readDeltaSlice(path, fromOffset, size);
  const seenToolUse = new Set();
  // turn_context arrives once per turn — often in an earlier delta than the
  // usage records it describes, so the caller feeds back the persisted model.
  let currentModel = priorModel;
  for (const line of slice.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // ordinal is the rollout's monotonic cursor — reuse the requestId
    // high-water slot so persisted state stays shape-identical.
    if (typeof rec.ordinal === "number") {
      if (highWater != null && rec.ordinal <= highWater) continue;
      if (scan.maxSeenRequestId == null || rec.ordinal > scan.maxSeenRequestId) {
        scan.maxSeenRequestId = rec.ordinal;
      }
    }
    const payload = rec.payload ?? {};
    if (rec.type === "turn_context") {
      if (typeof payload.model === "string") {
        currentModel = payload.model;
        scan.model = currentModel; // persisted → fed back as priorModel
      }
      continue;
    }
    if (rec.type === "token_usage_record") {
      const u = payload.usage;
      if (u == null) continue;
      const bucket = modelBucket(scan, currentModel ?? "unknown");
      scan.usage.turnCount++;
      bucket.turnCount++;
      const turnUsage = {
        turnCount: 0,
        // Codex input includes cached and cache-written tokens; Claude's
        // canonical input bucket contains only ordinary input.
        inputTokens: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0) - (u.cache_write_input_tokens ?? 0)),
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cached_input_tokens ?? 0,
        cacheCreationTokens: u.cache_write_input_tokens ?? 0,
        outputThinkingTokens: u.reasoning_output_tokens ?? 0,
        toolUseCount: 0,
        costInUsd: 0,
      };
      addUsageInto(scan.usage, turnUsage);
      addUsageInto(bucket, turnUsage);
      if (currentModel != null) {
        scan.model = currentModel;
        const cost = costOf({ ...turnUsage, turnCount: 1 }, currentModel);
        scan.usage.costInUsd += cost;
        bucket.costInUsd += cost;
      }
      continue;
    }
    if (rec.type === "event_msg") {
      if (payload.type === "task_complete") scan.turnDurationMs += payload.duration_ms ?? 0;
      continue;
    }
    if (rec.type !== "response_item") continue;
    if (CODEX_CALL_TYPES.has(payload.type)) {
      const key = payload.call_id ?? payload.id;
      if (key == null || seenToolUse.has(key)) continue;
      seenToolUse.add(key);
      const bucket = modelBucket(scan, currentModel ?? "unknown");
      scan.usage.toolUseCount++;
      bucket.toolUseCount++;
      if (payload.name === "spawn_agent" || payload.name === "spawnAgent") scan.spawnedSubagent = true;
      if (CODEX_FAILED_STATUS.has(payload.status)) continue;
      const savers = codexSaverCalls(payload);
      savers.forEach((s, i) => {
        const equiv = equivalentCallsFor(s.name, s.input);
        if (equiv > 0) pendingSaver.set(`${key}#${i}`, equiv);
      });
      for (const s of savers) {
        if (ownToolKind(s.name) === "Edit" && Array.isArray(s.input?.edits)) {
          for (const e of s.input.edits) {
            scan.codeEditLines.linesAdded += lc(e?.new_string);
            scan.codeEditLines.linesRemoved += lc(e?.old_string);
            scan.codeEditLines.editsApplied++;
          }
        }
      }
      continue;
    }
    if (CODEX_OUTPUT_TYPES.has(payload.type)) {
      const callId = payload.call_id;
      if (callId == null) continue;
      const failed = CODEX_FAILED_STATUS.has(payload.status) || codexOutputFailed(payload.output);
      for (const k of [...pendingSaver.keys()]) {
        if (k !== callId && !k.startsWith(callId + "#")) continue;
        const equiv = pendingSaver.get(k);
        pendingSaver.delete(k);
        if (!failed) {
          scan.saverCalls++;
          scan.equivalentNativeToolCalls += equiv;
        }
      }
    }
  }
  return { scan, byteOffset };
}

// ---------- session update ----------

function mergeScanIntoSlice(slice, scanResult) {
  const { scan } = scanResult;
  addUsageInto(slice.usage, scan.usage);
  if (scan.model != null) slice.model = scan.model;
  if (scan.lastStopReason != null) slice.lastStopReason = scan.lastStopReason;
  if (scan.maxSeenRequestId != null) slice.maxSeenRequestId = scan.maxSeenRequestId;

  if (scan.saverCalls > 0) {
    slice.saverCalls += scan.saverCalls;
    slice.equivalentNativeToolCalls += scan.equivalentNativeToolCalls;
    slice.pendingEquivalentSum += scan.equivalentNativeToolCalls;
    slice.pendingCallCount += scan.saverCalls;
  }
  if (slice.pendingCallCount > 0 && slice.usage.turnCount > 0) {
    recordCallSavings(slice, slice.pendingEquivalentSum, slice.pendingCallCount, slice.model);
    slice.pendingEquivalentSum = 0;
    slice.pendingCallCount = 0;
  }
}

export function sessionStatePath(sessionId) {
  return join(ensureHome(), "sessions", `${sessionId}.json`);
}

export function loadSessionState(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(sessionStatePath(sessionId), "utf8"));
    return normalizeState(raw);
  } catch {
    return normalizeState(undefined);
  }
}

// Hooks for parallel agents (codex spawn_agent fan-out, claude parallel
// Task calls) run in separate processes and can load → update → save the
// same session file concurrently. Re-read what's on disk and union-merge:
// different agents touch different subagent keys, so their writes compose.
// A lost same-slice update self-heals on the next event (the scanner
// resumes from the persisted byte offset).
function pickSlice(disk, ours) {
  if (disk == null) return ours;
  if (ours == null) return disk;
  if (disk.transcriptPath !== ours.transcriptPath) return ours; // live writer owns the path change
  return (disk.byteOffset ?? 0) > (ours.byteOffset ?? 0) ? disk : ours;
}

export function saveSessionState(sessionId, state) {
  if (!SESSION_FILE_RE.test(`${sessionId}.json`)) return;
  const disk = loadSessionState(sessionId);
  const mergedSubagents = Object.assign(Object.create(null), disk.subagents);
  for (const [id, s] of Object.entries(state.subagents ?? {})) mergedSubagents[id] = pickSlice(disk.subagents[id], s);
  const max = (a, b) => Math.max(a ?? 0, b ?? 0);
  state = {
    ...state,
    parent: pickSlice(disk.parent, state.parent),
    subagents: mergedSubagents,
    compactions: {
      countAuto: max(disk.compactions.countAuto, state.compactions?.countAuto),
      countManual: max(disk.compactions.countManual, state.compactions?.countManual),
      timeSpentCompactingInMs: max(disk.compactions.timeSpentCompactingInMs, state.compactions?.timeSpentCompactingInMs),
    },
    codeEditLines: {
      linesAdded: max(disk.codeEditLines.linesAdded, state.codeEditLines?.linesAdded),
      linesRemoved: max(disk.codeEditLines.linesRemoved, state.codeEditLines?.linesRemoved),
      editsApplied: max(disk.codeEditLines.editsApplied, state.codeEditLines?.editsApplied),
    },
  };
  rollup(state);
  writeJsonAtomic(sessionStatePath(sessionId), state);
}

// Incrementally fold new transcript bytes into the session state file.
// hostName selects the transcript dialect (claude JSONL vs codex rollout);
// the persisted state and the returned shape are host-agnostic.
// agentId selects the slice: subagent hooks (codex spawn_agent, and claude
// hooks firing inside Task agents) carry an agent id and report the AGENT's
// transcript path — each gets its own slice under state.subagents so byte
// offsets never mix between files, while rollup() still merges usage.
// Returns the updated state, or undefined when there is nothing to do.
const MAX_TRACKED_SUBAGENTS = 50;
export function updateSessionFromTranscript(sessionId, transcriptPath, hostName, agentId) {
  if (typeof sessionId !== "string" || !SESSION_FILE_RE.test(`${sessionId}.json`)) return undefined;
  if (typeof transcriptPath !== "string" || transcriptPath === "") return undefined;
  let size;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return undefined;
  }
  const state = loadSessionState(sessionId);
  let slice = state.parent;
  if (typeof agentId === "string" && agentId !== "") {
    if (!Object.hasOwn(state.subagents, agentId)) {
      if (Object.keys(state.subagents).length >= MAX_TRACKED_SUBAGENTS) return state;
      state.subagents[agentId] = normalizeSlice(undefined);
    }
    slice = state.subagents[agentId];
  }
  // Each slice is bound to one transcript file; if the path ever changes
  // (e.g. an agent rollout is rotated), restart the scan for that file.
  if (slice.transcriptPath !== transcriptPath) {
    slice.transcriptPath = transcriptPath;
    slice.byteOffset = 0;
    slice.maxSeenRequestId = undefined;
    slice.pendingSaverCalls = {};
  }
  if (size <= (slice.byteOffset ?? 0)) return state;
  const scanDelta = hostName === "codex" ? scanCodexTranscriptDelta : scanTranscriptDelta;
  const pending = new Map(Object.entries(slice.pendingSaverCalls ?? {}));
  const result = scanDelta(transcriptPath, slice.byteOffset ?? 0, slice.maxSeenRequestId, pending, slice.model);
  // Persist unpaired saver calls for the next scan; cap the map so calls
  // whose output record never arrives cannot grow it without bound.
  while (pending.size > 500) pending.delete(pending.keys().next().value);
  slice.pendingSaverCalls = pending.size > 0 ? Object.fromEntries(pending) : {};
  state.codeEditLines.linesAdded += result.scan.codeEditLines.linesAdded;
  state.codeEditLines.linesRemoved += result.scan.codeEditLines.linesRemoved;
  state.codeEditLines.editsApplied += result.scan.codeEditLines.editsApplied;
  addCostToDaily(slice, result.scan.usage.costInUsd);
  state.serviceTier ??= result.scan.serviceTier;
  mergeScanIntoSlice(slice, result);
  slice.byteOffset = result.byteOffset;
  rollup(state);
  saveSessionState(sessionId, state);
  return state;
}

// ---------- aggregates ----------

export function sessionStatsSummary(state) {
  const s = state.accumulatedSavings ?? emptySavings();
  return {
    ...s,
    timeSavedInMs: s.callsSaved * TIME_SAVED_PER_CALL_MS,
    totalSaverCalls: state.totalSaverCalls ?? 0,
    equivalentNativeToolCalls: state.equivalentNativeToolCalls ?? 0,
    codeEditLines: state.codeEditLines,
    compactions: {
      countAuto: state.compactions?.countAuto ?? 0,
      countManual: state.compactions?.countManual ?? 0,
      timeSpentCompactingInMs: state.compactions?.timeSpentCompactingInMs ?? 0,
    },
    model: state.model,
  };
}

// Lifetime rollup over every persisted session file.
export function lifetimeStats() {
  const dir = join(tokensaverHome(), "sessions");
  const totals = { ...emptySavings(), sessionCount: 0, lastUpdatedAt: undefined };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return totals;
  }
  for (const name of names) {
    if (!SESSION_FILE_RE.test(name)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const s = normalizeState(raw).accumulatedSavings;
      addSavingsInto(totals, s);
      if ((s.callsSaved ?? 0) > 0 || (s.costSavedInUsd ?? 0) > 0) totals.sessionCount++;
      const mtime = statSync(join(dir, name)).mtime.toISOString();
      if (totals.lastUpdatedAt == null || mtime > totals.lastUpdatedAt) totals.lastUpdatedAt = mtime;
    } catch {}
  }
  return totals;
}
