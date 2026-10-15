// Search tool: fused glob + content-regex + read in one bounded response.
// Output is an XML-ish envelope:
//   <cwd path="abs" />
//   <file path="rel" size="1.2KB" modified="YYYY-MM-DD HH:MM" [status=…]>…</file>
//   <not-found path="…" hint="…">…</not-found>
//   <search_result if_modified_since="YYYY-MM-DD HH:MM:SS" />
//   <hint line>
// Statuses: error, unchanged, malformed-range, truncated, omitted.
// Content cap (claude/mcp-tool): env TOKENSAVER_MAX_MCP_OUTPUT_TOKENS
// (default 25000, max 150000) * 0.5 * 4 chars; 72% for file content,
// 16% for wrapper/diagnostics.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, isAbsolute } from "node:path";
import { globBase, globToRegex, isGlobPattern } from "../lib/glob.mjs";
import { normalizePath, resolveSessionPath } from "../lib/paths.mjs";
import { truncateLine } from "../lib/lineio.mjs";
import { mcpText, mcpError } from "../lib/errors.mjs";
import { skeletonize } from "../lib/skeleton.mjs";
import { Script } from "node:vm";
import { loadSettings } from "../lib/config.mjs";
import { createGitIgnoreFilter } from "../lib/git-ignore.mjs";
import { buildImportGraph, TSJS_EXT } from "../lib/import-graph.mjs";

const IMAGE_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const DOC_TYPES = { ".pdf": "application/pdf" };
const SKIP_DIRS = new Set([".git", ".svn", ".hg", "node_modules", ".venv", "__pycache__"]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_LINE = 1000;
const DEFAULT_LINES_PER_FILE = 500;
const TRUNC_NOTE_LINE_LIMIT = 50;

const CAP_ENV = "TOKENSAVER_MAX_MCP_OUTPUT_TOKENS";
const CAP_TOKENS_DEFAULT = 25000;
const CAP_TOKENS_MAX = 150000;
const CONTENT_BUDGET_FRACTION = 0.72;
const WRAPPER_BUDGET_FRACTION = 0.16;
const CHARS_PER_TOKEN = 4;
const TOKEN_TO_CHARS = 0.5;

const NARROW_CONTENT_HINT =
  "Narrow the query (tighten content_regex, lower lines_per_file, add file_limit) or target specific files with #line-range suffixes.";
const NARROW_GLOB_HINT =
  "Narrow the query (tighten file_glob_patterns or content_regex, add file_limit) or list a subdirectory at a time.";
const MALFORMED_RANGE_TEXT =
  "line-range suffix not recognized — expected \"#N\" or \"#N-M\"; range not applied.";
const RESULT_LINE_HINT =
  "Reuse if_modified_since only for content already received. Omit it when retrieving truncated sections or changing the query.";

function envCap() {
  const raw = process.env[CAP_ENV];
  let v = CAP_TOKENS_DEFAULT;
  if (raw != null && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) v = Math.min(parsed, CAP_TOKENS_MAX);
  }
  return Math.floor(v * TOKEN_TO_CHARS * CHARS_PER_TOKEN);
}

function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + "KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + "MB";
  if (bytes < 1099511627776) return (bytes / 1073741824).toFixed(1) + "GB";
  return (bytes / 1099511627776).toFixed(1) + "TB";
}

function fmtModified(d) {
  return d.toISOString().slice(0, 16) + "Z";
}

function fmtStamp(d) {
  return d.toISOString().slice(0, 19) + "Z";
}

function displayPath(cwd, abs) {
  const rel = relative(cwd, abs);
  return rel.startsWith("..") ? resolve(abs) : normalizePath(rel);
}

// ---------- file walking ----------

function* walk(dir, { includeDirs = false, ignored = () => false } = {}) {
  if (ignored(dir, true)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (ignored(p, e.isDirectory())) continue;
    if (e.isDirectory()) {
      if (includeDirs) yield p;
      yield* walk(p, { includeDirs, ignored });
    } else if (e.isFile()) {
      yield p;
    }
  }
}

function expandPattern(pattern, cwd, ignored) {
  const clean = normalizePath(pattern);
  if (!isGlobPattern(clean)) {
    const abs = resolveSessionPath(clean, cwd);
    try {
      const st = statSync(abs);
      return { files: st.isFile() ? [abs] : [], dir: st.isDirectory() ? abs : undefined };
    } catch {
      return { notFound: { pattern: clean, resolvedPathAbs: abs } };
    }
  }
  const base = globBase(clean);
  const baseAbs = isAbsolute(clean) ? resolve(base) : join(cwd, base);
  const regex = globToRegex(clean);
  const patternSuffix = clean.startsWith(base + "/") ? clean.slice(base.length + 1) : clean;
  const suffixRe = globToRegex(patternSuffix);
  const files = [];
  const matchedDirs = [];
  const matches = (abs) => {
    const rel = normalizePath(relative(cwd, abs));
    if (regex.test(rel)) return true;
    const insideBase = normalizePath(relative(baseAbs, abs));
    return suffixRe.test(insideBase) || suffixRe.test(normalizePath(abs));
  };
  for (const f of walk(baseAbs, { includeDirs: true, ignored })) {
    if (!matches(f)) continue;
    try {
      if (statSync(f).isDirectory()) matchedDirs.push(f);
      else files.push(f);
    } catch {}
  }
  return { files, matchedDirs };
}

// ---------- matching ----------

function buildContentRegex(pattern, { ignoreCase, multiline }) {
  // `m` is always on: in a line-oriented search tool ^/$ are expected to
  // anchor at line boundaries, not at file start/end. `s` stays opt-in.
  const flags = (ignoreCase ? "i" : "") + "m" + (multiline ? "s" : "") + "g";
  return new RegExp(pattern, flags);
}

function findMatches(text, regex) {
  const lines = text.split("\n");
  const offsets = [0];
  for (let i = 0; i < lines.length; i++) offsets.push(offsets[i] + lines[i].length + 1);
  const matches = [];
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(text)) !== null) {
    const end = m.index + m[0].length;
    let startLine = 1;
    let lo = 0, hi = offsets.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= m.index) {
        startLine = mid + 1;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let endLine = startLine;
    lo = startLine - 1; hi = offsets.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= Math.max(end - 1, m.index)) {
        endLine = mid + 1;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    matches.push({ start: m.index, end, lineStart: startLine, lineEnd: endLine });
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }
  return matches;
}

// Compile and execute the regexp inside the timed context. Passing a regexp
// created in the host context would leave its native execution unbounded.
const MATCH_SCRIPT = new Script(`(${findMatches.toString()})(text, new RegExp(pattern, flags))`);

// Merge overlapping match windows + context into display blocks.
function mergeBlocks(matches, lines, before, after) {
  const blocks = [];
  for (const m of matches) {
    const start = Math.max(1, m.lineStart - before);
    const end = Math.min(lines.length, m.lineEnd + after);
    const last = blocks[blocks.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
      last.matchStarts.push(m.lineStart);
    } else {
      blocks.push({ start, end, matchStarts: [m.lineStart] });
    }
  }
  return blocks;
}

function renderBlocks(lines, blocks, { maxLineLength }) {
  const out = [];
  for (const b of blocks) {
    for (let i = b.start; i <= b.end; i++) {
      let line = lines[i - 1];
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const numbered = i + ":" + line;
      out.push(truncateLine(numbered, maxLineLength));
    }
  }
  return out.join("\n");
}

// ---------- TS/JS summary ----------

const SIGNATURE_RE = /^\s*(?:export\s+default\s+|export\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?\s+\w+|class\s+\w+|interface\s+\w+|type\s+\w+|enum\s+\w+|const\s+\w+\s*[:=]|let\s+\w+\s*[:=]|var\s+\w+\s*[:=]|(?:public|private|protected|static|readonly|override|async|get|set|abstract)\s+)+[\w$]+\s*[(<]?/;
const MEMBER_RE = /^\s*(?:public|private|protected|static|readonly|override|async|abstract|declare\s+)?(?:get|set)\s+[\w$]+\s*\(|^\s*[\w$]+\s*[?]?\s*[:=:(]/;

function summarizeTsFile(text, maxLineLength) {
  const lines = text.split("\n");
  const out = [];
  let depth = 0;
  let skipping = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (skipping > 0) {
      const opens = (line.match(/[{([]/g) ?? []).length;
      const closes = (line.match(/[})\]]/g) ?? []).length;
      skipping += opens - closes;
      if (skipping <= 0) skipping = 0;
      continue;
    }
    const isComment = /^\/\//.test(trimmed) || /^\/\*/.test(trimmed) || /^\*/.test(trimmed);
    const isDecl = SIGNATURE_RE.test(line) || (depth > 0 && MEMBER_RE.test(line)) ||
      isComment || /^\s*(import|export\s*\*|export\s*\{)/.test(line) || trimmed === "";
    if (isDecl) {
      out.push(truncateLine(line, maxLineLength));
    } else if (trimmed !== "") {
      out.push(line.replace(/[^ \t].*$/, "").trimEnd() + "…");
    }
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    if (depth < 0) depth = 0;
    if (isDecl && /[{([]\s*$/.test(line) && !line.includes("=>") === false) {
      skipping = 1;
    }
  }
  return out.join("\n");
}

// ---------- <file> tag render ----------

function renderFileTag(entry, cwd) {
  const path = xmlEscape(displayPath(cwd, entry.absPath));
  const meta = entry.meta
    ? ` size="${fmtSize(entry.meta.sizeInBytes)}" modified="${fmtModified(entry.meta.modifiedAt)}"`
    : "";
  const open = `<file path="${path}"${meta}`;
  const outcome = entry.readOutcome;
  if (outcome?.type === "error") return `${open} status="error">\n${outcome.message}\n</file>`;
  if (outcome?.type === "unchanged") return `${open} status="unchanged" />`;
  if (outcome?.type === "malformed-range") return `${open} status="malformed-range">\n${MALFORMED_RANGE_TEXT}\n</file>`;
  const matches = entry.matchCount != null ? ` total-matches="${entry.matchCount}"` : "";
  if (entry.capState === "omitted") {
    return `${open} status="omitted"${matches} chars-omitted="${entry.charsOmitted ?? 0}" />`;
  }
  const body = entry.suffix ? entry.content + "\n" + entry.suffix : entry.content;
  if (entry.capState === "truncated") {
    return `${open} status="truncated"${matches} chars-omitted="${entry.charsOmitted ?? 0}">\n${body}\n</file>`;
  }
  return `${open}${matches}>\n${body}\n</file>`;
}

// Global content cap: first file over the remaining budget is truncated at
// a line boundary, later files become metadata-only stubs, and if even the
// wrapper doesn't fit the tail is dropped entirely.
function enforceCap(entries, cwd, diagnostics, stoppedAtBudget) {
  const contentBudget = Math.floor(envCap() * CONTENT_BUDGET_FRACTION);
  const wrapperBudget = Math.floor(envCap() * WRAPPER_BUDGET_FRACTION);
  let used = 0;
  let wrapperUsed = 0;
  let truncating = false;
  let truncated = 0, dropped = 0, removed = 0, omittedUnits = 0;
  const measure = (s) => s.length;
  const stubSize = (e) => measure(renderFileTag({ ...e, content: "", suffix: undefined, capState: "omitted" }, cwd));

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    e.content ??= "";
    if (truncating) {
      omittedUnits += measure(e.content ?? "");
      const tag = stubSize(e);
      if (wrapperUsed + tag > wrapperBudget) {
        for (let j = i; j < entries.length; j++) omittedUnits += measure(entries[j].content ?? "");
        removed = entries.length - i;
        entries.splice(i);
        break;
      }
      wrapperUsed += tag;
      if (e.content?.length) {
        e.capState = "omitted";
        e.charsOmitted = e.content.length;
        e.content = "";
        e.suffix = undefined;
        dropped++;
      }
      continue;
    }
    const remaining = contentBudget - used;
    const rendered = renderFileTag(e, cwd);
    if (measure(rendered) <= remaining) {
      used += measure(rendered);
      continue;
    }
    if (e.readOutcome) {
      e.content = e.readOutcome.message ?? "";
      e.readOutcome = undefined;
    }
    const overhead = measure(renderFileTag({ ...e, content: "", capState: "truncated", charsOmitted: e.content.length }, cwd));
    const budget = Math.max(0, remaining - overhead);
    const cut = cutAtLineBoundary(e.content, budget);
    omittedUnits += e.content.length - cut.length;
    e.charsOmitted = e.content.length - cut.length;
    e.content = cut;
    e.capState = "truncated";
    used += measure(renderFileTag(e, cwd));
    truncated++;
    truncating = true;
  }
  if (truncated || dropped || removed) {
    const parts = [];
    if (truncated) parts.push(`truncated ${truncated} file(s)`);
    if (dropped) parts.push(`dropped ${dropped} trailing file(s)`);
    if (removed) parts.push(`omitted ${removed} more file(s) entirely`);
    if (stoppedAtBudget) parts.push("remaining files not read");
    diagnostics.push(
      `Output exceeded total-content cap of ${contentBudget.toLocaleString("en-US")} chars: ` +
      `${parts.join(", ")} (${omittedUnits.toLocaleString("en-US")} chars of content omitted). ` +
      NARROW_CONTENT_HINT,
    );
    return true;
  }
  return false;
}

function cutAtLineBoundary(content, budget) {
  if (content.length <= budget) return content;
  let end = content.lastIndexOf("\n", budget);
  if (end <= 0) end = budget;
  return content.slice(0, end);
}

// ---------- main ----------

export async function runSearch(args, { cwd: sessionCwd } = {}) {
  if (loadSettings().enabled === false) return mcpError("tokenSaver is disabled in settings.", "TOKENSAVER_DISABLED");
  const cwd = resolve(args.cwd ?? sessionCwd ?? process.cwd());
  const ignored = args.include_ignored ? () => false : createGitIgnoreFilter(cwd);
  const startedAt = new Date();
  const diagnostics = [];
  if (!args.content_regex && !args.file_glob_patterns && !args.type) {
    return mcpError("Error: Provide content_regex, file_glob_patterns, or type parameter.", "SEARCH_BAD_ARGS");
  }

  const outputMode = args.output_mode ?? "file_paths_with_content";
  const maxLineLength = args.max_line_length === 0 ? Infinity : (args.max_line_length ?? DEFAULT_MAX_LINE);
  const linesPerFile = args.lines_per_file === 0 ? Infinity : (args.lines_per_file ?? DEFAULT_LINES_PER_FILE);
  const before = args.lines_before ?? 0;
  const after = args.lines_after ?? 0;
  const modifiedSince = args.if_modified_since ? new Date(args.if_modified_since) : undefined;
  const isTextMode = outputMode === "file_paths_with_content";

  let regex;
  if (args.content_regex) {
    try {
      regex = buildContentRegex(args.content_regex, { ignoreCase: args.ignore_case, multiline: args.multiline });
    } catch (e) {
      return mcpError(`Error: invalid content_regex — ${e.message}`, "SEARCH_BAD_ARGS");
    }
  }

  // Build effective glob list.
  const patterns = [...(args.file_glob_patterns ?? [])];
  const typeExtension = args.type ? "." + args.type.replace(/^\./, "").toLowerCase() : undefined;
  if (patterns.length === 0) patterns.push("**/*");

  // Resolve patterns → files, tracking per-pattern line ranges.
  const fileEntries = new Map(); // absPath -> { absPath, ranges[] }
  const notFounds = [];
  const dirListings = [];
  const matchedDirs = [];
  const globRangeWarns = [];
  for (const raw of patterns) {
    let pattern = raw;
    let range;
    const hashIdx = raw.lastIndexOf("#");
    if (hashIdx > 0) {
      const suffix = raw.slice(hashIdx);
      const m = /^#(\d+)(?:-(\d+))?$/.exec(suffix);
      if (m) {
        pattern = raw.slice(0, hashIdx);
        range = { startLine: parseInt(m[1], 10), endLine: m[2] ? parseInt(m[2], 10) : undefined };
        if (isGlobPattern(pattern)) {
          globRangeWarns.push(raw);
          range = undefined;
        }
      } else if (raw.toLowerCase().endsWith(".ipynb") === false && /^#/.test(suffix)) {
        diagnostics.push(`line-range suffix "${suffix}" not recognized — expected "#N" or "#N-M"; range not applied.`);
        pattern = raw.slice(0, hashIdx);
      }
    }
    const ex = expandPattern(pattern, cwd, ignored);
    if (ex.notFound) {
      notFounds.push(ex.notFound);
      continue;
    }
    if (ex.dir) {
      if (regex || isTextMode) {
        for (const f of walk(ex.dir, { ignored })) {
          if (typeExtension && extname(f).toLowerCase() !== typeExtension) continue;
          if (!fileEntries.has(f)) fileEntries.set(f, { absPath: f, ranges: [] });
        }
      } else if (!ignored(ex.dir, true)) dirListings.push(ex.dir);
      continue;
    }
    for (const d of ex.matchedDirs ?? []) matchedDirs.push(d);
    for (const f of ex.files ?? []) {
      if (typeExtension && extname(f).toLowerCase() !== typeExtension) continue;
      if (!fileEntries.has(f)) fileEntries.set(f, { absPath: f, ranges: [] });
      if (range) fileEntries.get(f).ranges.push(range);
    }
  }

  let files = [...fileEntries.values()];
  files.sort((a, b) => a.absPath.localeCompare(b.absPath));

  // The import graph scans the whole project, not just the matched files.
  const importers = args.list_importers && isTextMode
    ? buildImportGraph(cwd, [...walk(cwd, { ignored })])
    : undefined;
  const imageBlocks = [];
  let imageBytes = 0;
  const entries = [];
  let renderedChars = 0;
  let countedEntries = 0;
  let matchedFiles = 0;
  let stoppedAtBudget = false;

  for (const f of files) {
    while (countedEntries < entries.length) {
      const counted = entries[countedEntries++];
      renderedChars += renderFileTag(counted, cwd).length;
      if (!regex || counted.matchCount > 0) matchedFiles++;
    }
    if (isTextMode && renderedChars >= envCap() * CONTENT_BUDGET_FRACTION) {
      stoppedAtBudget = true;
      break;
    }
    if (args.file_limit != null && matchedFiles >= args.file_limit) break;
    const abs = f.absPath;
    const ext = extname(abs).toLowerCase();
    const entry = { absPath: abs };
    try {
      const st = statSync(abs);
      entry.meta = { sizeInBytes: st.size, modifiedAt: st.mtime };
    } catch {}
    if (!isTextMode && !regex) {
      entries.push({ ...entry, content: "" });
      continue;
    }
    if (modifiedSince && entry.meta && entry.meta.modifiedAt <= modifiedSince) {
      entry.readOutcome = { type: "unchanged" };
      entries.push(entry);
      continue;
    }
    if (entry.meta?.sizeInBytes > MAX_FILE_BYTES) {
      entry.readOutcome = { type: "error", message: "File exceeds the 4 MiB read limit; use a tool that supports streaming large files." };
      entries.push(entry);
      continue;
    }
    const imgType = IMAGE_TYPES[ext];
    if (imgType && !args.content_regex) {
      try {
        const data = readFileSync(abs);
        if (imageBlocks.length >= 4 || imageBytes + data.length > MAX_IMAGE_BYTES) throw new Error("Image attachment budget exceeded (4 images / 8 MiB per call).");
        imageBytes += data.length;
        imageBlocks.push({ absPath: abs, block: { type: "image", data: data.toString("base64"), mimeType: imgType } });
        entry.content = `[image ${basename(abs)} — attached as image content]`;
      } catch (e) {
        entry.readOutcome = { type: "error", message: String(e.message ?? e) };
      }
      entries.push(entry);
      continue;
    }
    if (DOC_TYPES[ext]) {
      entry.readOutcome = { type: "error", message: "PDF text extraction not yet supported" };
      entries.push(entry);
      continue;
    }
    let text;
    try {
      const buf = readFileSync(abs);
      if (buf.subarray(0, 8192).includes(0)) {
        entry.readOutcome = { type: "error", message: "binary file" };
        entries.push(entry);
        continue;
      }
      text = buf.toString("utf8");
    } catch (e) {
      entry.readOutcome = { type: "error", message: String(e.message ?? e) };
      entries.push(entry);
      continue;
    }
    const lines = text.split("\n");
    const lastDocLine = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

    if (!regex) {
      // Read mode: whole file or #line-range slices.
      let content;
      if (f.ranges.length > 0) {
        const parts = [];
        for (const r of f.ranges) {
          const s = Math.max(1, r.startLine);
          const e = r.endLine == null ? lastDocLine : Math.min(r.endLine, lastDocLine);
          for (let i = s; i <= e; i++) parts.push(truncateLine(i + ":" + lines[i - 1], maxLineLength));
        }
        content = parts.join("\n");
      } else if (args.summary === true) {
        content = (await skeletonize(abs, text)) ?? (TSJS_EXT.has(ext) ? summarizeTsFile(text, maxLineLength) : undefined) ??
          lines.slice(0, Math.min(lastDocLine, linesPerFile)).map((l, i) => truncateLine(i + 1 + ":" + l, maxLineLength)).join("\n");
      } else {
        const capped = lines.slice(0, Math.min(lastDocLine, linesPerFile));
        content = capped.map((l, i) => truncateLine(i + 1 + ":" + l, maxLineLength)).join("\n");
      }
      entry.content = content;
      if (importers) {
        const by = importers.get(normalizePath(abs));
        if (by?.size) {
          entry.suffix = "--- Imported by ---\n" + [...by].map((p) => displayPath(cwd, p)).join("\n");
        }
      }
      entries.push(entry);
      continue;
    }

    // Content-regex mode.
    let matches;
    try {
      matches = MATCH_SCRIPT.runInNewContext({ text, pattern: regex.source, flags: regex.flags }, { timeout: 1000 });
    } catch (e) {
      return mcpError(`Search interrupted in ${displayPath(cwd, abs)}: ${e.message}. Simplify content_regex.`, "SEARCH_REGEX_FAILED");
    }
    const ranged = f.ranges.length
      ? matches.filter((m) => f.ranges.some((r) => m.lineStart <= (r.endLine ?? Infinity) && m.lineEnd >= r.startLine))
      : matches;
    if (outputMode === "file_paths_with_match_count") {
      if (ranged.length > 0) {
        entry.matchCount = ranged.length;
        entry.content = "";
        entries.push(entry);
      }
      continue;
    }
    if (!isTextMode) {
      if (ranged.length > 0) {
        entry.matchCount = ranged.length;
        entries.push(entry);
      }
      continue;
    }
    if (ranged.length === 0) continue;
    entry.matchCount = ranged.length;
    const shown = ranged.slice(0, linesPerFile);
    const blocks = mergeBlocks(shown, lines, before, after);
    let content = renderBlocks(lines, blocks, { maxLineLength });
    if (ranged.length > shown.length) {
      const rest = ranged.slice(shown.length);
      const startLines = [...new Set(rest.map((m) => m.lineStart))];
      const first = startLines.slice(0, TRUNC_NOTE_LINE_LIMIT).join(", ");
      const more = startLines.length > TRUNC_NOTE_LINE_LIMIT ? `, +${startLines.length - TRUNC_NOTE_LINE_LIMIT} more` : "";
      content += `\n[${rest.length} more matches truncated by lines_per_file limit; match lines: ${first}${more}]`;
    }
    if (args.summary === true) {
      const skel = (await skeletonize(abs, text)) ?? (TSJS_EXT.has(ext) ? summarizeTsFile(text, maxLineLength) : null);
      if (skel != null) content = skel + "\n--- Matches ---\n" + content;
    }
    entry.content = content;
    if (importers) {
      const by = importers.get(normalizePath(abs));
      if (by?.size) {
        entry.suffix = "--- Imported by ---\n" + [...by].map((p) => displayPath(cwd, p)).join("\n");
      }
    }
    entries.push(entry);
  }

  // Assemble envelope.
  const parts = [`<cwd path="${xmlEscape(cwd)}" />`];
  let contentCapped = false;
  if (outputMode === "file_paths_only") {
    const paths = entries.filter((e) => !regex || e.matchCount > 0).map((e) => displayPath(cwd, e.absPath));
    if (regex) {
      const skipped = entries.filter((e) => e.readOutcome);
      if (skipped.length) diagnostics.push(`${skipped.length} file(s) not searched (unreadable or unchanged); no match result is available for them.`);
    }
    if (!regex && !typeExtension) for (const d of matchedDirs) paths.push(displayPath(cwd, d) + "/");
    for (const d of dirListings) {
      try {
        for (const name of readdirSync(d)) {
          const child = join(d, name);
          const directory = statSync(child).isDirectory();
          if ((directory && SKIP_DIRS.has(name)) || ignored(child, directory)) continue;
          if (typeExtension && extname(child).toLowerCase() !== typeExtension) continue;
          paths.push(displayPath(cwd, child) + (directory ? "/" : ""));
        }
      } catch {}
    }
    const shown = [];
    let used = 0;
    for (const p of [...new Set(paths)].sort()) {
      const escaped = xmlEscape(p);
      if ((args.file_limit != null && shown.length >= args.file_limit) || used + escaped.length + 1 > envCap() * CONTENT_BUDGET_FRACTION) break;
      shown.push(escaped);
      used += escaped.length + 1;
    }
    if (shown.length < paths.length) diagnostics.push(`File list truncated; narrow the glob or search a subdirectory. ${NARROW_GLOB_HINT}`);
    if (shown.length === 0) parts.push("<file-list />");
    else parts.push("<file-list>\n" + shown.join("\n") + "\n</file-list>");
  } else {
    contentCapped = enforceCap(entries, cwd, diagnostics, stoppedAtBudget);
    for (const e of entries) parts.push(renderFileTag(e, cwd));
  }
  // One truncation notice: the cap message already covers unread files.
  if (stoppedAtBudget && !contentCapped) diagnostics.push("Search stopped at the output budget; narrow the query to retrieve remaining files.");
  for (const nf of notFounds) {
    const hint = `**/${basename(nf.pattern)}`;
    parts.push(
      `<not-found path="${xmlEscape(nf.pattern)}" hint="${xmlEscape(hint)}">\n` +
      `Does not exist at "${xmlEscape(nf.resolvedPathAbs)}". If it lives elsewhere in the project, ` +
      `search the hint glob; if it's outside the project, use an absolute path.\n</not-found>`,
    );
  }
  for (const w of globRangeWarns) {
    diagnostics.push(`line-range on wildcard pattern "${w}" ignored — ranges apply only to literal file paths; the whole matched files were searched.`);
  }
  parts.push(`<search_result if_modified_since="${fmtStamp(startedAt)}" />`);
  // The hint only matters when content was cut short; skip it otherwise.
  if (contentCapped || stoppedAtBudget) parts.push(RESULT_LINE_HINT);
  for (const d of diagnostics) parts.push(d);

  const boundedParts = [];
  let remaining = Math.max(0, envCap() - 120);
  for (const part of parts) {
    if (part.length + 1 > remaining) {
      boundedParts.push("Output truncated by total response limit; narrow the query.");
      break;
    }
    boundedParts.push(part);
    remaining -= part.length + 1;
  }
  const text = boundedParts.join("\n");
  if (imageBlocks.length > 0) {
    const visible = new Set(entries.filter((e) => !e.capState && text.includes(renderFileTag(e, cwd))).map((e) => e.absPath));
    return { content: [{ type: "text", text }, ...imageBlocks.filter((i) => visible.has(i.absPath)).map((i) => i.block)] };
  }
  return mcpText(text);
}

export const searchSchema = {
  name: "Search",
  description:
    "Fused file discovery + content search + read in one bounded call. Prefer this over shell grep/find/cat.",
  inputSchema: {
    type: "object",
    properties: {
      content_regex: { type: "string", description: "Regular expression to search file contents." },
      include_ignored: { type: "boolean", description: "Include paths excluded by project .gitignore files. Literal file paths always bypass ignore rules. Default false." },
      file_glob_patterns: {
        type: "array",
        items: { type: "string" },
        description: "Exact paths and/or glob patterns relative to cwd (or absolute). #N / #N-M line-range suffix on literal paths.",
      },
      output_mode: {
        type: "string",
        enum: ["file_paths_with_content", "file_paths_only", "file_paths_with_match_count"],
        description: "Result shape; default file_paths_with_content.",
      },
      lines_before: { type: "integer", minimum: 0 },
      lines_after: { type: "integer", minimum: 0 },
      ignore_case: { type: "boolean", description: "Case insensitive search" },
      type: { type: "string", description: 'File type to search, e.g. "ts", "js", "sql", "txt".' },
      file_limit: { type: "integer", exclusiveMinimum: 0 },
      lines_per_file: { type: "integer", description: "Omitted = 500, 0 = no per-file cap." },
      if_modified_since: { type: "string" },
      max_line_length: { type: "integer", description: "Omitted = 1000, 0 = unlimited." },
      multiline: { type: "boolean" },
      cwd: { type: "string" },
      summary: {
        type: "boolean",
        description: "Return an AST skeleton (signatures, imports, structure) instead of full contents — ~60% smaller. Works for py/java/rs/php/ts/js/go/c/cpp.",
      },
      list_importers: { type: "boolean" },
    },
  },
};
