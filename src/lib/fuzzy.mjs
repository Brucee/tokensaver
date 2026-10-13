// Fuzzy line-window matcher for the Edit tool.
// Behavioral spec (Part J.1 of the analysis doc): Levenshtein-normalized
// similarity over sliding line windows, with anchor pre-filter, ambiguity
// margin, edge anchoring, indent-scope guard and a time budget.

const MIN_SIMILARITY = 0.9;        // default acceptance threshold
const WINDOW_TOLERANCE = 0.1;      // window length ±10% of target lines
const AMBIGUITY_MARGIN = 0.05;     // second-best within this of best = ambiguous
const EDGE_LINES = 3;              // head/tail anchor line count
const EDGE_MIN_SIMILARITY = 0.85;
const TIME_BUDGET_MS = 2000;
const ANCHOR_MAX = 3;              // top-N anchor tokens required to exist
const ANCHOR_MIN_LEN = 12;
const ANCHOR_TRUNC = 30;

export function levenshtein(a, b, deadline = Infinity) {
  if (a === b) return 0;
  if (b.length > a.length) [a, b] = [b, a];
  let previous = Uint32Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    if (Date.now() >= deadline) return Infinity;
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1]
        : Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + 1);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

export function similarity(a, b, caseSensitive = true, deadline = Infinity) {
  if (!caseSensitive) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return shorter.length === 0 ? 1 : 0;
  return (longer.length - levenshtein(longer, shorter, deadline)) / longer.length;
}

// Top-N distinctive tokens from the target text: longest \S+ per line,
// min 12 chars, truncated to 30 — used as a cheap required-presence filter.
export function anchorTokens(targetLines) {
  const tokens = [];
  for (const line of targetLines) {
    const words = line.match(/\S+/g);
    if (!words) continue;
    const longest = words.reduce((a, w) => (w.length > a.length ? w : a)).slice(0, ANCHOR_TRUNC);
    if (longest.length >= ANCHOR_MIN_LEN) tokens.push(longest);
  }
  return tokens.sort((a, b) => b.length - a.length).slice(0, ANCHOR_MAX);
}

export function leadingWs(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

function dominantIndentChar(lines, start = 0, end) {
  const last = end ?? lines.length;
  for (let i = start; i < last; i++) {
    if (lines[i].startsWith("\t")) return "\t";
    if (lines[i].startsWith(" ")) return " ";
  }
  return " ";
}

function shiftIndent(lines, delta, indentChar) {
  if (delta === 0) return lines;
  return lines.map((line) => {
    const trimmed = line.trimStart();
    if (!trimmed) return line;
    const current = line.length - trimmed.length;
    return indentChar.repeat(Math.max(0, current + delta)) + trimmed;
  });
}

// Re-indent newLines so they land at the indentation depth implied by the
// matched slice: median of (fileIndent - targetIndent) over lines whose
// trimmed content matches, applied with the file's dominant indent char.
export function indentRewrite(fileSliceLines, targetLines, newLines) {
  const deltas = [];
  const n = Math.min(fileSliceLines.length, targetLines.length);
  for (let i = 0; i < n; i++) {
    const fileTrim = fileSliceLines[i].trimStart();
    const targetTrim = targetLines[i].trimStart();
    if (!fileTrim || !targetTrim || fileTrim !== targetTrim) continue;
    deltas.push((fileSliceLines[i].length - fileTrim.length)
      - (targetLines[i].length - targetTrim.length));
  }
  if (deltas.length === 0) return newLines;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return shiftIndent(newLines, median, dominantIndentChar(fileSliceLines));
}

// Sliding-window fuzzy search. fileLines/targetLines/newLines are arrays of
// lines (with trailing newlines preserved). Returns undefined when no match.
export function fuzzyFind(fileLines, targetJoined, targetLines, newLines, threshold = MIN_SIMILARITY) {
  if (targetLines.length < 3) return undefined;
  const anchors = anchorTokens(targetLines);
  if (anchors.length > 0 && !anchors.some((a) => fileLines.some((l) => l.includes(a)))) {
    return undefined;
  }

  let best = 0;
  let bestStart = -1;
  let bestEnd = -1;
  const candidates = [];
  const minWindow = Math.floor(targetLines.length * (1 - WINDOW_TOLERANCE));
  const maxWindow = Math.ceil(targetLines.length * (1 + WINDOW_TOLERANCE));
  const joined = fileLines.join("");
  const offsets = [0];
  for (let i = 0; i < fileLines.length; i++) offsets.push(offsets[i] + fileLines[i].length);

  const deadline = Date.now() + TIME_BUDGET_MS;
  for (let w = minWindow; w <= maxWindow; w++) {
    for (let s = 0; s <= fileLines.length - w; s++) {
      if (Date.now() >= deadline) return undefined;
      const score = similarity(joined.substring(offsets[s], offsets[s + w]), targetJoined, true, deadline);
      if (Date.now() >= deadline) return undefined;
      if (score >= threshold - AMBIGUITY_MARGIN) candidates.push({ score, start: s, end: s + w });
      if (score > best) {
        best = score;
        bestStart = s;
        bestEnd = s + w;
      }
    }
  }

  if (best < threshold) return undefined;
  // Ambiguity: second candidate within margin and windows don't overlap/nest.
  if (candidates.some((c) => (c.end <= bestStart || c.start >= bestEnd) && c.score > best - AMBIGUITY_MARGIN)) return undefined;
  // Edge anchoring for equal-length matches on multi-line targets.
  if (bestEnd - bestStart === targetLines.length && targetLines.length >= EDGE_LINES * 2) {
    if (similarity(fileLines.slice(bestStart, bestStart + EDGE_LINES).join(""),
      targetLines.slice(0, EDGE_LINES).join(""), true, deadline) < EDGE_MIN_SIMILARITY) return undefined;
    if (similarity(fileLines.slice(bestEnd - EDGE_LINES, bestEnd).join(""),
      targetLines.slice(-EDGE_LINES).join(""), true, deadline) < EDGE_MIN_SIMILARITY) return undefined;
  }
  // Indent-scope guard: don't bleed into a deeper-indented following block.
  let lastIn;
  for (let i = bestEnd - 1; i >= bestStart; i--) {
    if (fileLines[i].trim() !== "") { lastIn = fileLines[i]; break; }
  }
  let firstAfter;
  for (let i = bestEnd; i < fileLines.length; i++) {
    if (fileLines[i].trim() !== "") { firstAfter = fileLines[i]; break; }
  }
  if (lastIn != null && firstAfter != null && leadingWs(firstAfter) > leadingWs(lastIn)) {
    return undefined;
  }

  const appliedAt = { startLine: bestStart + 1, endLine: bestEnd };
  const rewritten = indentRewrite(fileLines.slice(bestStart, bestEnd), targetLines, newLines);
  return {
    content: [...fileLines.slice(0, bestStart), ...rewritten, ...fileLines.slice(bestEnd)].join(""),
    appliedAt,
    matchRanges: [appliedAt],
    similarity: best,
  };
}

// "Did you mean" — ranked candidate list with threshold + ambiguity margin.
export function didYouMean(query, candidates, { threshold = 0, ambiguityMargin = 0, caseSensitive = false } = {}) {
  const ranked = candidates
    .map((c) => ({ match: c, score: similarity(query, c, caseSensitive) }))
    .sort((a, b) => b.score - a.score);
  const [top, runner] = ranked;
  if (!top || top.score <= threshold) return undefined;
  if (ambiguityMargin > 0 && runner && top.score - runner.score < ambiguityMargin) {
    return undefined;
  }
  return top;
}
