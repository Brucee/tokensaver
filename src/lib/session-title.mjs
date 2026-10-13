// Session title derivation — scrubs secrets/paths/noise from the prompt and
// compresses to a short capitalized title. Also scans the transcript to pick
// the first real user prompt and detect externally-set titles.
import { openSync, readSync, closeSync, statSync } from "node:fs";

// ---------- pipeline constants ----------

const TAG_NAMES = String.raw`system-reminder|local-command-(?:caveat|stdout|stderr)|task-notification|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr`;
const RE_TAG_LINE = new RegExp(String.raw`^<(?:${TAG_NAMES})>`);
const RE_TAG_BLOCKS = new RegExp(String.raw`<(${TAG_NAMES})>[\s\S]*?(?:</\1>|$)`, "g");
const RE_FENCE_CLOSED = /```[\s\S]*?```/g;
const RE_FENCE_OPEN = /```[\s\S]*$/;
const RE_URL = /\bhttps?:\/\/\S+/gi;
const RE_MENTION = /@\S+/g;
const RE_SECRET_BLOCK = /-{5}\s*BEGIN [A-Z0-9 ]+-{5}[\s\S]*?(?:-{5}\s*END [A-Z0-9 ]+-{5}|$)/gi;
const SECRET_WORD = String.raw`(?:password|passwd|passphrase|secret|token|api[-_ ]?key)s?(?:[_-][A-Za-z0-9_-]{0,32})?`;
const SECRET_VALUE = String.raw`[:=](?:[ \t\r]*(?=[^\n]*\S)[^\n]*|(?:[ \t\r]*\n)+[ \t\r]*[^\n]*)(?:\n[ \t]+[^\n]*)*`;
const RE_KV_SECRET = new RegExp(String.raw`(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,32}[_-]){0,8}${SECRET_WORD}["'` + "`" + String.raw`]?\s*${SECRET_VALUE}`, "gi");
const RE_FLAG_SECRET = new RegExp(String.raw`(?<![A-Za-z0-9])--?${SECRET_WORD}\s+(?:"[^"\n]*"|'[^'\n]*'|\S+)`, "gi");
const RE_AUTH_SCHEME = /\b(bearer|basic)\s+(\S{4,})/gi;
const RE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const RE_ASCII_PAIR = /^[\x20-\x7e]+:[\x20-\x7e]*$/;
const RE_USERINFO_URI = /\b[a-z][a-z0-9+.-]{0,31}:\/\/(?=[^\s/?#]*@)\S*/gi;
const KEY_PATTERNS = [
  String.raw`\b(?:sk|pk|rk)(?:-[A-Za-z0-9_-]{16,}|_(?:live|test)_[A-Za-z0-9]{16,})`,
  String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{16,}`,
  String.raw`\bglpat-[A-Za-z0-9_-]{16,}`,
  String.raw`\bxox[baprs]-[A-Za-z0-9-]{16,}`,
  String.raw`\bA(?:KIA|SIA)[0-9A-Z]{16}(?![0-9A-Z])`,
  String.raw`\bAIza[A-Za-z0-9_-]{20,}`,
  String.raw`\b(?:npm|hf)_[A-Za-z0-9_-]{16,}`,
];
const RE_API_KEY = new RegExp(KEY_PATTERNS.map((p) => "(?:" + p + ")").join("|"), "g");
const RE_CONTROL = /[\p{Cc}\p{Cf}]/gu;
const RE_MD_PUNCT = /[`*#<>[\](){}"]/g;
const RE_EDGE_UNDERSCORE = /(?<=^|\s)_+|_+(?=\s|$)/g;
const RE_PATH = /\b(?:[A-Za-z]:[\\/]|[\w.-]{1,255}[\\/])[\w.-]{1,255}(?:[\\/][\w.-]{1,255})*/g;
const PATH_BASENAME_MIN = 16;
const RE_WS = /\s+/g;
const RE_SENTENCE_END = /[.?!;](?=\s|$)|[。！？；।॥؟…]/;
const RE_TRAILING_PUNCT = /[\s,;:.\-–—、，；：。！？؟।॥…]+$/;
const RE_COMMA_PUNCT = /[,;:—–、，；：]/g;
const RE_COMMA = /[,、，]/g;
const RE_FILLER = /^(?:hey|hi|ok|okay|so|now|just|please|thanks|can you(?: please)?|could you(?: please)?|would you|will you|i(?:'d| would) like (?:you )?to|i (?:want|need) (?:you )?to|let'?s|help me|we (?:should|need to))\b[\s,:-]*/i;
const STOPWORDS = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });
const SEPARATOR_ONLY = new Set(["/", "\\", "-", "_", ".", ":", "'", "’", "+"]);
const MAX_INPUT = 64000;
const PRE_TITLE_CAP = 240;
const TITLE_CAP = 40;
const MAX_WORDS = 6;
const WORD_CHAR_BUDGET = 40;
const TRANSCRIPT_SCAN_LIMIT = 200;
const TAIL_BYTES = 512 * 1024;

function capInput(prompt) {
  if (prompt.length <= MAX_INPUT) return prompt;
  const cut = prompt.slice(0, MAX_INPUT);
  const code = cut.charCodeAt(cut.length - 1);
  return code >= 55296 && code <= 56319 ? cut.slice(0, -1) : cut;
}

function codePoints(str, n) {
  const arr = [...str];
  return arr.length <= n ? str : arr.slice(0, n).join("");
}

function isBase64UserPass(payload) {
  if (!RE_BASE64.test(payload)) return false;
  return RE_ASCII_PAIR.test(Buffer.from(payload, "base64").toString("utf8"));
}

function scrubAuthScheme(match, scheme, payload) {
  return scheme.toLowerCase() !== "basic" || isBase64UserPass(payload) ? " " : match;
}

function basename(path) {
  if (path.length < PATH_BASENAME_MIN) return path;
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(cut + 1);
}

function isSeparatorOnly(s) {
  if (s === "") return false;
  for (const ch of s) if (!SEPARATOR_ONLY.has(ch)) return false;
  return true;
}

// Word ranges; separator-only runs glued onto the preceding word.
function wordRanges(text) {
  const ranges = [];
  let pendingEnd;
  for (const { segment, index, isWordLike } of SEGMENTER.segment(text)) {
    const end = index + segment.length;
    const last = ranges[ranges.length - 1];
    if (isWordLike !== true) {
      pendingEnd = last?.endIndex === index && isSeparatorOnly(segment) ? end : undefined;
      continue;
    }
    if (pendingEnd === index && last != null) {
      last.endIndex = end;
    } else {
      ranges.push({ startIndex: index, endIndex: end });
    }
    pendingEnd = undefined;
  }
  return ranges;
}

function lastPunctIndex(text) {
  let idx = -1;
  for (const m of text.matchAll(RE_COMMA_PUNCT)) idx = m.index;
  return idx;
}

// Trim to ≤6 words / ≤40 chars of content, cutting at the last punctuation
// boundary and dropping trailing stopwords.
function trimWords(text) {
  const ranges = wordRanges(text);
  const kept = [];
  for (const r of ranges) {
    if (kept.length >= MAX_WORDS || (kept.length > 0 && [...text.slice(0, r.endIndex)].length > WORD_CHAR_BUDGET)) break;
    kept.push(r);
  }
  const last = kept[kept.length - 1];
  if (last != null && kept.length < ranges.length) {
    let punct = lastPunctIndex(text.slice(0, last.endIndex));
    while (punct > 0 && kept.length > 1 && kept[kept.length - 1].startIndex >= punct) {
      kept.pop();
      punct = lastPunctIndex(text.slice(0, kept[kept.length - 1].endIndex));
    }
  }
  while (kept.length > 1) {
    const r = kept[kept.length - 1];
    if (!STOPWORDS.has(text.slice(r.startIndex, r.endIndex).toLowerCase())) break;
    kept.pop();
  }
  const end = kept[kept.length - 1];
  return end == null ? "" : text.slice(0, end.endIndex);
}

function stripFiller(text) {
  let prev = "";
  let cur = text;
  while (prev !== cur) {
    prev = cur;
    cur = cur.replace(RE_FILLER, "").trimStart();
  }
  return cur;
}

export function deriveTitle(prompt) {
  const trimmed = capInput(prompt).trim();
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.startsWith("!") || RE_TAG_LINE.test(trimmed)) {
    return undefined;
  }
  const scrubbed = trimmed
    .replace(RE_TAG_BLOCKS, " ")
    .replace(RE_FENCE_CLOSED, " ")
    .replace(RE_FENCE_OPEN, " ")
    .replace(RE_SECRET_BLOCK, " ")
    .replace(RE_KV_SECRET, " ")
    .replace(RE_FLAG_SECRET, " ")
    .replace(RE_AUTH_SCHEME, scrubAuthScheme)
    .replace(RE_USERINFO_URI, " ")
    .replace(RE_API_KEY, " ")
    .replace(RE_URL, " ")
    .replace(RE_MENTION, " ")
    .replace(RE_PATH, basename)
    .replace(RE_CONTROL, " ")
    .replace(RE_MD_PUNCT, " ")
    .replace(RE_EDGE_UNDERSCORE, " ")
    .replace(RE_WS, " ")
    .trim();
  const candidate = stripFiller(codePoints(scrubbed, PRE_TITLE_CAP));
  const sentenceEnd = candidate.search(RE_SENTENCE_END);
  const toSentence = sentenceEnd > 0 ? candidate.slice(0, sentenceEnd) : candidate;
  const bounded = trimWords(toSentence);
  if (bounded === "" || STOPWORDS.has(bounded.trim().toLowerCase())) return undefined;
  const cleaned = bounded.replace(RE_COMMA, " ").replace(RE_WS, " ").trim();
  const title = codePoints(cleaned, TITLE_CAP).replace(RE_TRAILING_PUNCT, "");
  if (title === "") return undefined;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// ---------- transcript helpers ----------

function userText(record) {
  if (record.isCompactSummary === true || record.toolUseResult != null) return undefined;
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.filter((b) => b.type === "text").map((b) => b.text);
  return texts.length ? texts.join("\n") : undefined;
}

function* headLines(path, limit) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    let tail = "";
    let seen = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      tail += buf.subarray(0, n).toString("utf8");
      let idx;
      while ((idx = tail.indexOf("\n")) >= 0) {
        const line = tail.slice(0, idx);
        tail = tail.slice(idx + 1);
        if (line.trim()) {
          yield line;
          if (++seen >= limit) return;
        }
      }
    }
    if (tail.trim()) yield tail;
  } finally {
    closeSync(fd);
  }
}

function* tailLines(path, limit) {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES) || 1);
    const n = readSync(fd, buf, 0, buf.length, from);
    const lines = buf.subarray(0, n).toString("utf8").split("\n").filter((l) => l.trim());
    const start = Math.max(0, lines.length - limit);
    for (let i = lines.length - 1; i >= start; i--) yield lines[i];
  } finally {
    closeSync(fd);
  }
}

// First user-prompt title + whether an assistant turn exists, scanned forward.
export function firstPromptInfo(transcriptPath) {
  const info = { hasAssistantTurn: false, firstPromptTitle: undefined, agentType: undefined };
  let scanned = 0;
  for (const line of headLines(transcriptPath, TRANSCRIPT_SCAN_LIMIT)) {
    scanned++;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type === "assistant" && !rec.isSidechain) info.hasAssistantTurn = true;
    else if (rec?.type === "agent-setting") info.agentType = rec.agentSetting;
    else if (rec?.type === "user" && info.firstPromptTitle == null && !rec.isSidechain) {
      const text = userText(rec);
      if (text != null) info.firstPromptTitle = deriveTitle(text);
    }
    if ((info.hasAssistantTurn && info.firstPromptTitle != null) || scanned >= TRANSCRIPT_SCAN_LIMIT) break;
  }
  return info;
}

// True when the transcript already carries an explicit ai-title/agent-name
// (i.e. something else already named the session), scanning from the end.
export function hasExternalTitle(transcriptPath, agentType) {
  let lines;
  try {
    lines = [...tailLines(transcriptPath, TRANSCRIPT_SCAN_LIMIT)];
  } catch {
    return true; // unreadable transcript → assume already titled (upstream behavior)
  }
  let scanned = 0;
  let sawTitle = false;
  let sawName = false;
  for (const line of lines) {
    scanned++;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type === "ai-title" && !sawTitle) {
      const t = String(rec.aiTitle ?? "").trim();
      if (t !== "" && t !== agentType) return true;
      sawTitle = t !== "";
    } else if (rec?.type === "agent-name" && !sawName) {
      const t = String(rec.agentName ?? "").trim();
      if (t !== "" && t !== agentType) return true;
      sawName = t !== "";
    }
    if ((sawTitle && sawName) || scanned >= TRANSCRIPT_SCAN_LIMIT) break;
  }
  return false;
}
