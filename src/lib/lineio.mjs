// Line/byte utilities: newline-preserving split, inline truncation markers,
// and markdown fence selection for emitted file content.

const OMIT = "⋯";

export function splitKeepNewline(text) {
  if (text && !text.endsWith("\n")) text += "\n";
  const out = [];
  let i = 0;
  const re = /\r?\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(i, m.index) + m[0]);
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

// Truncate a line to `max` chars; the omitted middle is marked inline as
// "[⋯<firstCol>-<lastCol>]" so callers know exactly which columns were cut.
export function truncateLine(line, max) {
  if (max === 0 || line.length <= max) return line;
  const head = Math.floor(max / 2);
  const tail = max - head;
  const cutStart = head + 1;
  const cutEnd = line.length - tail;
  return line.slice(0, head) + `[${OMIT}${cutStart}-${cutEnd}]` + line.slice(line.length - tail);
}

// Pick a markdown fence that cannot collide with the content.
export function pickFence(content) {
  if (content.includes("````")) return "`````";
  if (content.includes("```")) return "````";
  return "```";
}

export function fenceBlock(content, lang = "") {
  const fence = pickFence(content);
  const trailingNl = content.startsWith("`") && !content.endsWith("\n") ? "\n" : "";
  return `${fence}${lang}\n${content}${trailingNl}${fence}`;
}
