// Unicode typography normalization for tolerant matching.
// Mirror of upstream semantics (Part J): smart quotes/dashes/ellipsis/nbsp
// fold to ASCII, literal \uXXXX and \n \t \r escapes decode to real chars,
// and every replacement is tracked so match offsets map back to the raw text.

const TYPO_MAP = {
  "“": "\"", "”": "\"", "„": "\"", "‟": "\"", "″": "\"", "‶": "\"",
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "‵": "'",
  "–": "-", "—": "-",
  "…": "...",
  "\u00A0": " ",
  "·": ".",
};

const ESCAPED_MAP = { "\\n": "\n", "\\t": "\t", "\\r": "\r" };

const NEEDS_NORM = /[\u00A0\u00B7\u2013\u2014\u2018-\u201F\u2026\u2032\u2033\u2035\u2036]/;
const ESCAPED_UNICODE = /\\u[0-9a-f]{4}/i;
const ESCAPED_SEQ = /\\\\|\\[ntr]/;

const NORM_RE = new RegExp(
  NEEDS_NORM.source + "|" + ESCAPED_UNICODE.source + "|" + ESCAPED_SEQ.source,
  "gi",
);
const QUICK_TEST = new RegExp(NORM_RE.source, "i");

export function needsNormalize(text) {
  return QUICK_TEST.test(text);
}

function decodeToken(token) {
  if (token.length === 6 && /^\\u/i.test(token)) {
    const ch = String.fromCodePoint(parseInt(token.slice(2), 16));
    return TYPO_MAP[ch] ?? ch;
  }
  if (token.length === 2 && ESCAPED_SEQ.test(token)) {
    return ESCAPED_MAP[token] ?? token;
  }
  return TYPO_MAP[token] ?? token;
}

// Returns { normalized, replacements[] } — replacements carry origIndex,
// origLength, replacementLength, cumulativeDelta for offset remapping.
export function normalizeText(text) {
  const replacements = [];
  let delta = 0;
  const normalized = text.replace(NORM_RE, (token, index) => {
    const replacement = decodeToken(token);
    delta += replacement.length - token.length;
    replacements.push({
      origIndex: index,
      origLength: token.length,
      replacementLength: replacement.length,
      cumulativeDelta: delta,
    });
    return replacement;
  });
  return { normalized, replacements };
}

// Map an offset in the normalized string back to the original string.
// `end=true` maps to the end boundary of a replacement token.
export function unmapOffset({ replacements }, normalizedIndex, end = false) {
  if (replacements.length === 0) return normalizedIndex;
  let lo = 0;
  let hi = replacements.length - 1;
  let delta = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rep = replacements[mid];
    const prevDelta = mid > 0 ? replacements[mid - 1].cumulativeDelta : 0;
    const start = rep.origIndex + prevDelta;
    if (start <= normalizedIndex) {
      if (normalizedIndex < start + rep.replacementLength) {
        if (!end) return rep.origIndex;
        return normalizedIndex === start
          ? rep.origIndex
          : rep.origIndex + rep.origLength;
      }
      delta = rep.cumulativeDelta;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return normalizedIndex - delta;
}
