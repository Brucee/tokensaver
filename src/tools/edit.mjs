// Edit tool: exact/normalized/fuzzy matching, replace_all, batch edits[],
// #line-range scoping, .ipynb cell ops, protected paths, ipynb shadow
// guardrail, and advisory syntax checks — with upstream response text.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";import { normalizePath, resolveSessionPath, protectedPathReason, ipynbShadowConflict } from "../lib/paths.mjs";
import { normalizeText, unmapOffset, needsNormalize } from "../lib/textnorm.mjs";
import { fuzzyFind, similarity } from "../lib/fuzzy.mjs";
import { splitKeepNewline } from "../lib/lineio.mjs";
import {
  hasWildcard, expandWildcard, hasLineElision, countOmitTags, expandOmitTags, replaceOmitTagOnce,
  parseLineRangeSuffix, parseCellSuffix, isIpynbPath,
} from "../lib/elision.mjs";
import { mcpError } from "../lib/errors.mjs";
import { checkSyntax } from "../lib/syntax.mjs";
import { featureEnabled, loadSettings } from "../lib/config.mjs";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const MATCHRANGES_CAP = 1000;
const OUTOFRANGE_CAP = 20;
const LIST_CAP = 10;
const TAIL_LINES = 3;
const LARGE_OVERWRITE_LINES = 200;
const LARGE_OLD_STRING_LINES = 50;

const lineWord = (n) => (Math.abs(n) === 1 ? "line" : "lines");

function offsetToLine(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

const countLines = (s) => (s === "" ? 0 : s.replace(/\n$/, "").split("\n").length);
const rangeText = (r) =>
  r.endLine != null && r.endLine !== r.startLine ? `#${r.startLine}-${r.endLine}` : `#${r.startLine}`;
const rangesText = (rs) => rs.map(rangeText).join(", ");
const editsCountText = (applied, total) =>
  applied < total ? `${applied} of ${total} edits applied` : `${total} ${total === 1 ? "edit" : "edits"}`;

// Shift a range after an earlier edit changed line counts at `pivot`.
function shiftRange(r, pivot, delta) {
  if (r.startLine >= pivot) {
    r.startLine = Math.max(1, r.startLine + delta);
    if (r.endLine != null) r.endLine = Math.max(r.startLine, r.endLine + delta);
  } else if (r.endLine != null && r.endLine >= pivot) {
    r.endLine = Math.max(r.startLine, r.endLine + delta);
  }
}

function applyState(errors, total) {
  if (errors >= total) return "failed";
  return errors > 0 ? "partial" : "applied";
}

// ---------- exact / normalized match ----------

function findAllOccurrences(content, needle) {
  const out = [];
  if (needle === "") return out;
  let i = 0;
  while ((i = content.indexOf(needle, i)) !== -1) {
    out.push(i);
    i += needle.length;
  }
  return out;
}

function inRange(line, range) {
  return line >= range.startLine && (range.endLine == null || line <= range.endLine);
}

function rangeDistance(line, range) {
  if (line < range.startLine) return range.startLine - line;
  if (range.endLine != null && line > range.endLine) return line - range.endLine;
  return 0;
}

// Single-replacement pipeline on plain text.
// Returns {content?, appliedAt?, matchRanges, similarity?, replacedCount?}
function matchOnce(content, oldString, newString, { replaceAll, lineRange, filePath }) {
  // CRLF files: an LF-only old_string still matches, and the replacement
  // keeps the file's own EOL style instead of silently rewriting to LF.
  if (content.includes("\r\n") && !oldString.includes("\r")) {
    oldString = oldString.replace(/\n/g, "\r\n");
    newString = newString.replace(/\n/g, "\r\n");
  }
  const oldLines = countLines(oldString);
  const newLines = countLines(newString);

  // --- elision pre-pass -------------------------------------------------
  let oldS = oldString;
  let newS = newString;
  let elided = false;
  if (hasWildcard(oldS) || hasLineElision(oldS) || countOmitTags(oldS) || countOmitTags(newS)) {
    const concrete = expandWildcard(content, oldS);
    if (concrete != null) {
      oldS = concrete;
      elided = true;
    }
    if (countOmitTags(oldS) || countOmitTags(newS)) {
      const oldTags = countOmitTags(oldS);
      const newTags = countOmitTags(newS);
      if (newTags !== oldTags) {
        return { error: `Inline omit tag count mismatch: search has ${oldTags} tag(s), replace has ${newTags}` };
      }
      const expanded = expandOmitTags(content, oldS);
      if (expanded == null) return { matchRanges: [] };
      oldS = expanded.concrete;
      for (const span of expanded.spans) newS = replaceOmitTagOnce(newS, span);
      elided = true;
    }
  }

  // --- replace_all: pure literal, no normalization ----------------------
  if (replaceAll) {
    const hits = findAllOccurrences(content, oldS);
    const matchRanges = [];
    const replacedStartLines = [];
    const outRanges = [];
    let applied = 0;
    let cursor = 0;
    const parts = [];
    for (const idx of hits) {
      const line = offsetToLine(content, idx);
      const endLine = offsetToLine(content, idx + oldS.length - 1);
      if (lineRange == null || (inRange(line, lineRange) && inRange(endLine, lineRange))) {
        const adjusted = line + applied * (newLines - oldLines);
        if (matchRanges.length < MATCHRANGES_CAP) {
          matchRanges.push({ startLine: adjusted, endLine: adjusted + newLines });
        }
        if (newLines !== oldLines) replacedStartLines.push(line);
        parts.push(content.slice(cursor, idx), newS);
        cursor = idx + oldS.length;
        applied++;
      } else if (outRanges.length < OUTOFRANGE_CAP) {
        outRanges.push({ startLine: line, endLine: line + oldLines });
      }
    }
    if (applied === 0) return { matchRanges: outRanges };
    parts.push(content.slice(cursor));
    return {
      content: parts.join(""),
      appliedAt: matchRanges[0],
      matchRanges,
      replacedCount: applied,
      replacedStartLines,
    };
  }

  // --- normalized exact match -------------------------------------------
  const normOld = needsNormalize(oldS) ? normalizeText(oldS) : { normalized: oldS, replacements: [] };
  const normContent = normalizeText(content);
  const needle = normOld.normalized;
  const hay = normContent.normalized;
  const hits = findAllOccurrences(hay, needle);
  const candidates = [];
  for (const idx of hits) {
    const origStart = unmapOffset(normContent, idx);
    const origEnd = unmapOffset(normContent, idx + needle.length, true);
    const line = offsetToLine(content, origStart);
    candidates.push({ origStart, origEnd, line });
  }

  if (candidates.length === 0) return { matchRanges: [] };

  let chosen;
  if (lineRange != null) {
    const inside = candidates.filter((c) => inRange(c.line, lineRange) && inRange(offsetToLine(content, c.origEnd - 1), lineRange));
    if (inside.length === 0) {
      return { matchRanges: candidates.map((c) => ({ startLine: c.line, endLine: c.line + oldLines })) };
    }
    if (inside.length > 1) return { ambiguous: true, matchRanges: inside.map((c) => ({ startLine: c.line, endLine: offsetToLine(content, c.origEnd - 1) })) };
    chosen = inside[0];
  } else if (candidates.length > 1) {
    return {
      ambiguous: true,
      matchRanges: candidates.map((c) => ({ startLine: c.line, endLine: c.line + oldLines })),
    };
  } else {
    chosen = candidates[0];
  }

  const matchedRaw = content.slice(chosen.origStart, chosen.origEnd);
  const startLine = chosen.line;
  return {
    content: content.slice(0, chosen.origStart) + newS + content.slice(chosen.origEnd),
    appliedAt: { startLine, endLine: startLine + newLines },
    matchRanges: [{ startLine, endLine: startLine + newLines }],
    matchedContent: elided ? undefined : matchedRaw !== oldS ? matchedRaw : undefined,
    elided,
  };
}

// ---------- syntax check (advisory) ----------
// Real parsing lives in src/lib/syntax.mjs — `node --check` for JS files and
// tree-sitter WASM grammars (grammars/) for python/java/rust/php/ts/tsx/go/c/cpp.

// ---------- notebook ----------

function parseNotebook(text) {
  try {
    const nb = JSON.parse(text);
    if (!Array.isArray(nb.cells) || nb.cells.some((c) => c == null || typeof c !== "object" ||
      (typeof c.source !== "string" && !(Array.isArray(c.source) && c.source.every((l) => typeof l === "string"))))) throw new Error("invalid cells");
    return nb;
  } catch {
    return undefined;
  }
}

function pickCell(nb, target) {
  if (nb.cells.length === 0) return { error: "notebook has no cells" };
  if (target.kind === "first") return { index: 0, cell: nb.cells[0] };
  if (target.kind === "last") return { index: nb.cells.length - 1, cell: nb.cells[nb.cells.length - 1] };
  if (target.kind === "index") {
    const i = target.index;
    return Number.isInteger(i) && i >= 0 && i < nb.cells.length ? { index: i, cell: nb.cells[i] } : { error: `cell index ${i} out of range (notebook has ${nb.cells.length} cells)` };
  }
  const hits = nb.cells.map((c, i) => ({ i, c })).filter(({ c }) => c.id === target.id);
  if (hits.length === 0) return { error: `no cell with id "${target.id}"` };
  if (hits.length > 1) {
    const list = hits.map(({ i, c }) => `${i} (id=${c.id})`).join(", ");
    return { error: `cell id "${target.id}" is ambiguous — matches cells ${list}` };
  }
  return { index: hits[0].i, cell: hits[0].c };
}

const cellSource = (cell) => (Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? "");

// ---------- main ----------

export async function runEdit(args, { cwd: sessionCwd } = {}) {
  if (loadSettings().enabled === false) return mcpError("tokenSaver is disabled in settings.", "TOKENSAVER_DISABLED");
  const cwd = args.cwd ? resolveSessionPath(args.cwd, sessionCwd ?? process.cwd()) : (sessionCwd ?? process.cwd());

  // The batch array is the only interface: every change goes through edits[].
  const entries = Array.isArray(args.edits) ? args.edits : [];
  if (entries.length === 0 || entries.every((e) => e.file_path == null)) {
    return mcpError("Error: provide edits[] with at least one entry carrying file_path.", "EDIT_BAD_ARGS");
  }

  // Group consecutive entries per file, preserving order.
  const groups = [];
  for (const e of entries) {
    const key = e.file_path ?? "";
    const last = groups.at(-1);
    if (last?.[0] === key) last[1].push(e);
    else groups.push([key, [e]]);
  }

  const resultTexts = [];
  const resultMeta = {
    appliedCount: 0,
    replaceAllOccurrences: 0,
    largeOverwrites: 0,
    largeOldStringEdits: 0,
    hadErrors: 0,
  };

  for (const [rawPath, edits] of groups) {
    let r;
    try {
      r = await applyFileEdits(rawPath, edits, cwd);
    } catch (e) {
      r = { text: `ERROR: ${rawPath}: ${e.message}`, isError: true, errorCode: "EDIT_IO_FAILED",
        appliedCount: 0, replaceAllOccurrences: 0, largeOverwrites: 0, largeOldStringEdits: 0, hadErrors: edits.length };
    }
    resultTexts.push(r.text);
    resultMeta.appliedCount += r.appliedCount;
    resultMeta.replaceAllOccurrences += r.replaceAllOccurrences;
    resultMeta.largeOverwrites += r.largeOverwrites;
    resultMeta.largeOldStringEdits += r.largeOldStringEdits;
    resultMeta.hadErrors += r.hadErrors;
    if (r.isError) resultMeta.lastErrorCode = r.errorCode;
  }

  const isError = resultMeta.hadErrors > 0;
  const out = { content: [{ type: "text", text: resultTexts.join("\n") }] };
  if (isError) {
    out.isError = true;
    out._meta = { errorCode: resultMeta.lastErrorCode ?? "EDIT_MATCH_FAILED" };
  }
  return out;
}

async function applyFileEdits(rawPath, edits, cwd) {
  const errors = [];
  const diagnostics = [];
  const applied = [];
  const meta = { appliedCount: 0, replaceAllOccurrences: 0, largeOverwrites: 0, largeOldStringEdits: 0, hadErrors: 0 };
  const prefix = (i) => (edits.length > 1 ? `Edit ${i + 1}: ` : "");

  // --- path parsing -----------------------------------------------------
  let pathPart = rawPath;
  let cellTarget;
  const cellParsed = parseCellSuffix(rawPath);
  if (cellParsed.cell) {
    pathPart = cellParsed.path;
    cellTarget = cellParsed.cell;
  }
  let lineRange;
  const rangeParsed = parseLineRangeSuffix(pathPart);
  if (rangeParsed.lineRangeError) {
    return {
      text: `ERROR: line-range suffix "${rangeParsed.lineRangeError}" on "${rawPath}" not recognized — edit skipped; re-issue with a valid #N-M, or drop the suffix to edit the whole file.`,
      isError: true,
      errorCode: "EDIT_MATCH_FAILED",
      ...meta, hadErrors: 1,
    };
  }
  if (rangeParsed.lineRange) {
    lineRange = rangeParsed.lineRange;
    pathPart = rangeParsed.path;
    if (lineRange.startLine < 1) {
      diagnostics.push(`line-range suffix "${rangeParsed.rawSuffix}" on "${rawPath}" adjusted to start at line 1 — line numbers start at 1.`);
      lineRange.startLine = 1;
    }
  }

  const absPath = resolveSessionPath(pathPart, cwd);
  const isNotebook = isIpynbPath(absPath);
  const protectedHit = protectedPathReason(absPath, cwd);
  if (protectedHit) {
    return {
      text: `ERROR: "${rawPath}" is inside a protected path (${protectedHit}) — edit refused.`,
      isError: true,
      errorCode: "EDIT_PROTECTED_PATH",
      ...meta, hadErrors: 1,
    };
  }

  // --- read -------------------------------------------------------------
  let original;
  try {
    original = readFileSync(absPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") {
      return {
        text: `Failed to read ${pathPart}: ${e.message}`,
        isError: true,
        errorCode: "EDIT_READ_FAILED",
        ...meta, hadErrors: 1,
      };
    }
  }
  const fileExists = original != null;
  const wantsCreate = edits.every((e) => e.old_string == null || e.overwrite);
  if (!fileExists && !wantsCreate) {
    return {
      text: `ERROR: file not found: ${pathPart} — it must exist before old_string edits can apply.`,
      isError: true,
      errorCode: "EDIT_FILE_NOT_FOUND",
      ...meta, hadErrors: 1,
    };
  }
  if (!fileExists) {
    const shadow = ipynbShadowConflict(absPath);
    if (shadow) {
      return {
        text: `ERROR: refused to create ${pathPart} — a sibling "${shadow}" already exists; edit the notebook or pick a different name.`,
        isError: true,
        errorCode: "EDIT_PY_SHADOW_GUARDRAIL",
        ...meta, hadErrors: 1,
      };
    }
  }

  if (isNotebook) {
    return applyNotebookEdits(rawPath, pathPart, absPath, edits, cellTarget, original, meta);
  }

  // --- sequential text edits --------------------------------------------
  let content = original ?? "";
  const total = edits.length;
  let localErrors = 0;

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const p = prefix(i);
    const newS = e.new_string ?? "";
    const oldS = e.old_string;

    if (countLines(oldS ?? "") > LARGE_OLD_STRING_LINES) meta.largeOldStringEdits++;

    if (e.overwrite || oldS == null) {
      if (oldS == null && fileExists && !e.overwrite) {
        errors.push(`${p}${pathPart} already exists — pass \`overwrite: true\` to replace it, or provide old_string for a targeted edit.`);
        localErrors++;
        continue;
      }
      // Full-file write / create.
      if (e.overwrite && fileExists && countLines(original) > LARGE_OVERWRITE_LINES) {
        meta.largeOverwrites++;
      }
      content = newS;
      applied.push({ appliedAt: { startLine: 1, endLine: countLines(newS) || 1 }, matchRanges: [] });
      continue;
    }
    if (oldS === "") {
      errors.push(`${p}old_string is empty — pass \`overwrite: true\` to replace the whole file, or provide the text to match.`);
      localErrors++;
      continue;
    }
    if (oldS === newS) {
      errors.push(`${p}old_string and new_string are identical — nothing to change.`);
      localErrors++;
      continue;
    }

    let result = matchOnce(content, oldS, newS, { replaceAll: e.replace_all, lineRange, filePath: pathPart });
    let similarityNote;
    if (result.content == null && !result.ambiguous && !result.error && !e.replace_all) {
      // Fuzzy fallback.
      const fileLines = splitKeepNewline(content);
      const start = lineRange ? Math.max(0, lineRange.startLine - 1) : 0;
      const end = lineRange?.endLine ?? fileLines.length;
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const targetLines = splitKeepNewline(oldS.replace(/\r?\n/g, eol));
      const fuzzy = fuzzyFind(fileLines.slice(start, end), targetLines.join(""), targetLines,
        splitKeepNewline(newS.replace(/\r?\n/g, eol)));
      if (fuzzy) {
        fuzzy.content = fileLines.slice(0, start).join("") + fuzzy.content + fileLines.slice(end).join("");
        fuzzy.appliedAt.startLine += start;
        fuzzy.appliedAt.endLine += start;
        result = fuzzy;
        similarityNote = fuzzy.similarity;
      }
    }
    if (result.error) {
      errors.push(`${p}${result.error}`);
      localErrors++;
      continue;
    }
    if (result.ambiguous) {
      errors.push(
        `${p}old_string matched ${result.matchRanges.length} times — ambiguous. ` +
        `Add 2-3 lines of surrounding context or scope with #line-range: ${rangesText(result.matchRanges.slice(0, LIST_CAP))}`,
      );
      localErrors++;
      continue;
    }
    if (result.content == null) {
      errors.push(`${p}old_string not found in ${pathPart}.`);
      localErrors++;
      continue;
    }

    // Track line delta for subsequent range reporting.
    const oldLines = countLines(oldS);
    const newLines = countLines(newS);
    if (result.replacedCount != null) {
      meta.replaceAllOccurrences += result.replacedCount;
    }
    const matchedSlice = similarityNote != null || result.elided ? fuzzyMatchedSlice(content, result.appliedAt) : undefined;
    content = result.content;
    const entry = {
      appliedAt: result.appliedAt,
      appliedIndex: 0,
      matchRanges: result.matchRanges ?? [],
      hadLineRange: lineRange != null,
    };
    if (similarityNote != null) {
      entry.similarity = similarityNote;
      entry.matchedContent = matchedSlice;
    }
    if (result.replacedCount != null) entry.replacedAllCount = result.replacedCount;
    applied.push(entry);
  }

  // --- write + post-checks ----------------------------------------------
  const anyApplied = applied.length > 0;
  let state = applyState(localErrors, total);
  if (anyApplied) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }

  const fileLabel = applied.length === 0
    ? pathPart
    : applied.length === 1
      ? pathPart + rangeText(applied[0].appliedAt)
      : `${pathPart} at ${applied.map((a) => rangeText(a.appliedAt)).join(", ")}`;

  const delta = countLines(content) - countLines(original ?? "");
  const change = original == null
    ? `new file, ${countLines(content)} ${lineWord(countLines(content))}`
    : delta > 0 ? `+${delta} ${lineWord(delta)}`
    : delta < 0 ? `${delta} ${lineWord(delta)}` : "modified";

  const warn = [];
  for (let i = 0; i < applied.length; i++) {
    const a = applied[i];
    const p = prefix(i);
    if (a.similarity != null) {
      let w = `${YELLOW}⚠ ${p}Applied via ${Math.round(a.similarity * 100)}% similarity match at ${pathPart}#${a.appliedAt.startLine}`;
      if (a.matchedContent) w += `\nActual content that was matched:\n${a.matchedContent}`;
      w += RESET;
      warn.push(w);
    }
    if (a.replacedAllCount > 1) {
      const shown = a.matchRanges.slice(0, LIST_CAP);
      const more = a.replacedAllCount - shown.length;
      warn.push(`ℹ ${p}replace_all replaced ${a.replacedAllCount} occurrences: ${rangesText(shown)}${more > 0 ? `, … and ${more} more` : ""}`);
      continue;
    }
    if (a.matchRanges.length > 1) {
      const extra = a.matchRanges.filter((_, j) => j !== a.appliedIndex);
      warn.push(`${YELLOW}⚠ ${p}${extra.length} additional ${extra.length === 1 ? "match" : "matches"}. Use file_path with #line to disambiguate: ${rangesText(extra)}${RESET}`);
    }
  }

  let syntaxNote = "";
  if (anyApplied && featureEnabled("syntaxValidation", cwd)) {
    try {
      const problems = await checkSyntax(absPath, content);
      if (problems.length > 0) {
        const shown = problems.slice(0, 3)
          .map((x) => `  ${x.column != null ? `${x.line}:${x.column}` : `${x.line}`} - ${x.message}`)
          .join("\n");
        syntaxNote = `\n\nSyntax errors:\n${shown}${problems.length > 3 ? `\n  ...and ${problems.length - 3} more` : ""}`;
      }
    } catch {}
  }

  let text = "";
  if (anyApplied) {
    const rangesAdjusted = applied.length > 1 && applied.some((a) => a.hadLineRange);
    text = `${fileLabel} (${editsCountText(total - localErrors, total)}, ${change})` +
      (warn.length ? "\n" + warn.join("\n") : "") +
      (rangesAdjusted ? "\nℹ Ranges are adjusted to final file positions." : "") +
      syntaxNote;
    if (meta.largeOverwrites > 0) {
      text += `\n⚠ Overwrote a mostly-unchanged ${countLines(original ?? "")}-line file by re-emitting its full contents. For a few changes to an existing file, prefer targeted edits or \`replace_all\`. Reserve \`overwrite\` for genuine full rewrites.`;
    }
    if (meta.largeOldStringEdits > 0) {
      text += `\n⚠ Large \`old_string\`: prefer a short unique marker or a \`#line-range\` (e.g. \`file#120-140\`) over quoting a big span.`;
    }
  }
  for (const d of diagnostics) text += (text ? "\n" : "") + d;
  if (errors.length) {
    text += (text ? "\n" : "") + errors.join("\n");
  }

  meta.appliedCount = applied.length;
  meta.hadErrors = localErrors;
  return {
    text,
    isError: localErrors > 0,
    errorCode: localErrors > 0 ? "EDIT_MATCH_FAILED" : undefined,
    ...meta,
  };
}

// Extract the file span a fuzzy/elided match covered — shown to the user as
// "Actual content that was matched" so a low-similarity hit can be audited.
function fuzzyMatchedSlice(content, appliedAt) {
  if (appliedAt?.startLine == null || appliedAt?.endLine == null) return undefined;
  const lines = content.split("\n");
  const slice = lines.slice(appliedAt.startLine - 1, appliedAt.endLine).join("\n");
  if (!slice) return undefined;
  return slice.length > 2000 ? slice.slice(0, 2000) + "\n…" : slice;
}

async function applyNotebookEdits(rawPath, pathPart, absPath, edits, cellTarget, original, meta) {
  const errors = [];
  const applied = [];
  let localErrors = 0;
  const prefix = (i) => (edits.length > 1 ? `Edit ${i + 1}: ` : "");

  let nb;
  if (original != null) {
    nb = parseNotebook(original);
    if (!nb) {
      return {
        text: "Notebook JSON is malformed and cannot be edited; repair it first.",
        isError: true,
        errorCode: "EDIT_READ_FAILED",
        ...meta, hadErrors: 1,
      };
    }
  } else {
    nb = { cells: [], nbformat: 4, nbformat_minor: 5, metadata: {} };
  }

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const p = prefix(i);
    if (e.replace_all) {
      errors.push(`${p}\`replace_all\` is not supported for notebook (.ipynb) edits.`);
      localErrors++;
      continue;
    }
    const action = e.cell_action;
    const newS = e.new_string ?? "";
    const toSourceArray = (s) => s.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l));
    const newCell = () => {
      const t = e.cell_type === "markdown" ? "markdown" : "code";
      return t === "code"
        ? { cell_type: "code", source: toSourceArray(newS), metadata: {}, outputs: [], execution_count: null }
        : { cell_type: "markdown", source: toSourceArray(newS), metadata: {} };
    };
    const moveTargetIndex = () => {
      const t = e.cell_move_target;
      if (t == null) return undefined;
      const pick = typeof t === "number"
        ? pickCell(nb, { kind: "index", index: t })
        : pickCell(nb, t === "first" || t === "last" ? { kind: t } : /^\d+$/.test(String(t)) ? { kind: "index", index: parseInt(t, 10) } : { kind: "id", id: String(t) });
      return pick.error ? pick : pick.index;
    };

    if (action === "delete") {
      if (cellTarget == null) {
        errors.push(`${p}\`cell_action: delete\` requires \`#cell=<target>\` in file_path.`);
        localErrors++;
        continue;
      }
      const pick = pickCell(nb, cellTarget);
      if (pick.error) {
        errors.push(`${p}${pick.error}`);
        localErrors++;
        continue;
      }
      nb.cells.splice(pick.index, 1);
      applied.push({ label: `deleted cell ${pick.index}${pick.cell?.id ? ` (id=${pick.cell.id})` : ""}` });
      continue;
    }
    if (action === "insert_after" || action === "insert_before") {
      let at;
      if (cellTarget) {
        const pick = pickCell(nb, cellTarget);
        if (pick.error) {
          errors.push(`${p}${pick.error}`);
          localErrors++;
          continue;
        }
        at = action === "insert_after" ? pick.index + 1 : pick.index;
      } else {
        at = nb.cells.length === 0 ? 0 : nb.cells.length;
      }
      const cell = newCell();
      nb.cells.splice(at, 0, cell);
      applied.push({ label: `inserted ${cell.cell_type} cell at ${at}` });
      continue;
    }
    if (action === "move_after" || action === "move_before") {
      if (cellTarget == null) {
        errors.push(`${p}\`cell_action: ${action}\` requires \`#cell=<target>\` in file_path.`);
        localErrors++;
        continue;
      }
      const pick = pickCell(nb, cellTarget);
      if (pick.error) {
        errors.push(`${p}${pick.error}`);
        localErrors++;
        continue;
      }
      const dest = moveTargetIndex();
      if (dest == null) {
        errors.push(`${p}\`cell_action: ${action}\` requires \`cell_move_target\`.`);
        localErrors++;
        continue;
      }
      if (dest.error) {
        errors.push(`${p}${dest.error}`);
        localErrors++;
        continue;
      }
      const [moved] = nb.cells.splice(pick.index, 1);
      const adjusted = dest > pick.index ? dest - 1 : dest;
      const at = action === "move_after" ? adjusted + 1 : adjusted;
      nb.cells.splice(at, 0, moved);
      applied.push({ label: `moved cell ${pick.index} → ${at}` });
      continue;
    }
    if (e.overwrite || (e.old_string == null && original == null)) {
      const replacement = parseNotebook(newS);
      if (!replacement) {
        errors.push(`${p}Invalid notebook JSON; overwrite skipped.`);
        localErrors++;
        continue;
      }
      nb = replacement;
      applied.push({ label: original == null ? "created notebook" : "overwrote notebook" });
      continue;
    }
    // Cell-scoped or notebook-wide text edit.
    const targets = cellTarget ? [pickCell(nb, cellTarget)] : nb.cells.map((c, i) => ({ index: i, cell: c }));
    if (cellTarget && targets[0].error) {
      errors.push(`${p}${targets[0].error}`);
      localErrors++;
      continue;
    }
    let hit;
    for (const t of targets) {
      const src = cellSource(t.cell);
      const res = matchOnce(src, e.old_string ?? "", newS, { replaceAll: false, lineRange: undefined });
      if (res.content != null) {
        if (hit) {
          errors.push(`${p}old_string matched multiple cells; use #cell=<target>.`);
          localErrors++;
          hit = { failed: true };
          break;
        }
        hit = { cell: t.cell, index: t.index, content: res.content, appliedAt: res.appliedAt };
      } else if (res.ambiguous) {
        errors.push(`${p}old_string matched ${res.matchRanges.length} times in cell ${t.index} — ambiguous; use #cell=<target> or more context.`);
        localErrors++;
        hit = { failed: true };
        break;
      }
    }
    if (hit?.failed) continue;
    if (!hit) {
      errors.push(`${p}old_string not found in ${cellTarget ? `cell (${JSON.stringify(cellTarget)})` : "notebook"}.`);
      localErrors++;
      continue;
    }
    hit.cell.source = hit.content.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l));
    applied.push({ label: `edited cell ${hit.index}` });
  }

  if (applied.length > 0) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, JSON.stringify(nb, null, 1) + "\n", "utf8");
  }
  const labels = applied.map((a) => a.label).join("; ");
  let text = applied.length ? `${pathPart} (${labels})` : "";
  if (errors.length) text += (text ? "\n" : "") + errors.join("\n");
  meta.appliedCount = applied.length;
  meta.hadErrors = localErrors;
  return {
    text,
    isError: localErrors > 0,
    errorCode: localErrors > 0 ? "EDIT_MATCH_FAILED" : undefined,
    ...meta,
  };
}

export const editSchema = {
  name: "Edit",
  description:
    "Exact/fuzzy search-replace edits: batch edits[] across files, file creation, #line-range and .ipynb #cell scoping.",
  inputSchema: {
    type: "object",
    properties: {
      cwd: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
            overwrite: { type: "boolean" },
            replace_all: { type: "boolean" },
            cell_action: { type: "string", enum: ["insert_after", "insert_before", "delete", "move_after", "move_before"] },
            cell_move_target: { anyOf: [{ type: "string" }, { type: "integer", minimum: 0 }] },
            cell_type: { type: "string" },
          },
        },
      },
    },
  },
};
