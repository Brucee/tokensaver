// Mechanical verification of reviewer findings: every finding must cite a
// real file:line, and near-duplicate findings across lenses get clustered so
// the synthesizer merges clusters instead of eyeballing duplicates.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const FINDING_RE = /^-\s*\*\*(blocker|major|minor|nit)\*\*\s+`([^`]+)`\s*\(([^)]+)\)\s*(.+)$/i;
const JACCARD_DUP = 0.55;

function parseFinding(raw) {
  const m = FINDING_RE.exec(raw.trim());
  if (!m) return null;
  const loc = m[2];
  const lm = /^(.*):(\d+)$/.exec(loc);
  return {
    severity: m[1].toLowerCase(),
    file: lm ? lm[1] : loc,
    line: lm ? parseInt(lm[2], 10) : null,
    lens: m[3],
    text: m[4],
  };
}

function citeStatus(f, cwd) {
  if (!f.file) return "unverifiable:no-file-cited";
  const abs = resolve(cwd, f.file);
  if (!existsSync(abs)) return "unverifiable:file-not-found";
  let total = 0;
  try {
    if (!statSync(abs).isFile()) return "unverifiable:not-a-file";
    if (f.line == null) return "verified:file-only";
    total = readFileSync(abs, "utf8").split("\n").length;
  } catch {
    return "unverifiable:unreadable";
  }
  return f.line >= 1 && f.line <= total ? "verified" : `unverifiable:line-out-of-range(1-${total})`;
}

function tokens(text) {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9_\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3),
  );
}

function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

// verifyFindings(text, {cwd}) → { findings: [...], unparsed: n, summary: {...} }
export function verifyFindings(text, { cwd = process.cwd() } = {}) {
  const findings = [];
  let unparsed = 0;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || /^no findings\.?$/i.test(trimmed)) continue;
    const parsed = parseFinding(trimmed);
    if (!parsed) {
      if (trimmed.startsWith("-")) unparsed++;
      continue;
    }
    findings.push({ index: findings.length, raw: trimmed, ...parsed, tokenSet: tokens(parsed.text + " " + parsed.file) });
  }
  // Cluster near-duplicates across lenses (first occurrence is canonical).
  for (const f of findings) {
    f.status = citeStatus(f, cwd);
    if (!f.status.startsWith("verified")) continue;
    for (const other of findings) {
      if (other.index >= f.index) break;
      if (other.duplicateOf != null) continue;
      if (!other.status?.startsWith("verified") || resolve(cwd, f.file) !== resolve(cwd, other.file) || f.line !== other.line || f.line == null) continue;
      if (jaccard(f.tokenSet, other.tokenSet) >= JACCARD_DUP) {
        f.duplicateOf = other.index;
        break;
      }
    }
  }
  const verified = findings.filter((f) => f.status.startsWith("verified")).length;
  const dups = findings.filter((f) => f.duplicateOf != null).length;
  return {
    verificationScope: "citation-only; correctness of findings requires code review",
    findings: findings.map(({ tokenSet, ...f }) => f),
    unparsed,
    summary: {
      total: findings.length,
      verified,
      unverifiable: findings.length - verified,
      duplicates: dups,
    },
  };
}
