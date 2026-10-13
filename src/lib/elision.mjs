// Elision syntax for Edit old_string/new_string and file_path suffixes.
// Behavioral spec (Part J.2):
//  - literal "/* ... */" inside old_string = middle wildcard anchored on
//    prefix and suffix (suffix searched after the closing brace block when
//    the prefix ends with "{")
//  - a line containing only "..." or "…" (optionally "… N-M") = line elision
//  - "[⋯" / "[..."] inline omit tags must appear the same number of times in
//    old and new strings; each tag splices back the matched span
//  - file_path "#N-M" line-range suffix (1-based, inclusive)

const WILDCARD = "/* ... */";
const LINE_ELISION_RE = /^\s*(?:\.\.\.|…)(?:\s*\d*\s*-\s*\d*\s*)?(?:\n|$)/gm;
const OMIT_TAG_RE = /\[(?:⋯|\.\.\.)(?:\d+-\d+)?\]/;
const OMIT_TAG_RE_G = /\[(?:⋯|\.\.\.)(?:\d+-\d+)?\]/g;
const LINE_RANGE_RE = /#(\d+)(?:-(\d+))?$/;
const CELL_RE = /^(.+\.ipynb)#cell=(.+)$/i;

export function hasWildcard(text) {
  return text.includes(WILDCARD);
}

export function hasLineElision(text) {
  LINE_ELISION_RE.lastIndex = 0;
  return LINE_ELISION_RE.test(text);
}

export function omitTags(text) {
  return text.match(OMIT_TAG_RE_G) ?? [];
}

export function countOmitTags(text) {
  return omitTags(text).length;
}

// Expand an old_string containing "/* ... */" into the concrete span it
// covers in `content`, or undefined when it can't be uniquely anchored.
export function expandWildcard(content, oldText) {
  const idx = oldText.indexOf(WILDCARD);
  if (idx === -1) return undefined;
  const prefix = oldText.substring(0, idx).trimEnd();
  const suffix = oldText.substring(idx + WILDCARD.length).trimStart();
  const start = prefix.length > 0 ? content.indexOf(prefix) : 0;
  if (start === -1) return undefined;
  // Prefix must occur exactly once when non-empty.
  if (prefix.length > 0 && content.includes(prefix, start + 1)) return undefined;
  const afterPrefix = start + prefix.length;
  if (suffix.length === 0) return content.substring(start);

  // If the prefix opens a block, the wildcard may span the whole block:
  // walk brace depth to find where the block closes.
  const opensBlock = prefix.trimEnd().endsWith("{");
  let depth = opensBlock ? 1 : 0;
  let searchFrom = afterPrefix;
  let blockClosed = !opensBlock;
  for (let i = afterPrefix; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{") depth++;
    else if (ch === "}" && (--depth, depth <= 0)) {
      searchFrom = i + 1;
      blockClosed = true;
      break;
    }
  }
  if (!blockClosed) searchFrom = afterPrefix;
  const suffixAt = content.indexOf(suffix, searchFrom - suffix.length);
  if (suffixAt !== -1) return content.substring(start, suffixAt + suffix.length);
  return undefined;
}

// Expand omit tags in old_string against the file content: each tag is a
// wildcard spanning whatever lies between its neighboring literal segments.
// Returns { concrete, spans } — the real file text to match plus the span each
// tag covered — or undefined when the anchor segments can't be found in order.
export function expandOmitTags(content, oldText) {
  const segs = oldText.split(OMIT_TAG_RE);
  if (segs.length === 1) return { concrete: oldText, spans: [] };
  const spans = [];
  let pos = 0;
  let concrete = "";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const at = seg === "" ? pos : content.indexOf(seg, pos);
    if (at === -1) return undefined;
    concrete += seg;
    pos = at + seg.length;
    if (i < segs.length - 1) {
      const next = segs[i + 1];
      const end = next === "" ? content.length : content.indexOf(next, pos);
      if (end === -1) return undefined;
      spans.push(content.slice(pos, end));
      concrete += content.slice(pos, end);
      pos = end;
    }
  }
  return { concrete, spans };
}

// Replace the first omit tag in `text` with `span` (one call per tag).
export function replaceOmitTagOnce(text, span) {
  return text.replace(OMIT_TAG_RE, () => span);
}

// Parse "path#N-M" or "path#N" → { path, lineRange:{startLine,endLine} }.
// Invalid suffix → { path, lineRangeError }. N=0 clamps to 1 upstream.
export function parseLineRangeSuffix(filePath) {
  const m = LINE_RANGE_RE.exec(filePath);
  if (!m) return { path: filePath };
  const start = parseInt(m[1], 10);
  const end = m[2] != null ? parseInt(m[2], 10) : start;
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return { path: filePath.slice(0, m.index), lineRangeError: m[0] };
  }
  return {
    path: filePath.slice(0, m.index),
    lineRange: { startLine: start, endLine: end },
    rawSuffix: m[0],
  };
}

// Parse "x.ipynb#cell=<target>" → { path, cell }.
export function parseCellSuffix(filePath) {
  const m = CELL_RE.exec(filePath);
  if (!m) return { path: filePath };
  const raw = m[2];
  let cell;
  if (raw === "first" || raw === "last") cell = { kind: raw };
  else if (/^\d+$/.test(raw)) cell = { kind: "index", index: parseInt(raw, 10) };
  else cell = { kind: "id", id: raw };
  return { path: m[1], cell, rawSuffix: m[0].slice(m[1].length) };
}

export function isIpynbPath(p) {
  return p.toLowerCase().endsWith(".ipynb");
}
