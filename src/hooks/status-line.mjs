// Status line renderer — reads the hook JSON on stdin ({session_id, agent}),
// loads session savings and writes a single status line on stdout.
import { readStdinJson } from "../lib/hookio.mjs";
import { loadSettings } from "../lib/config.mjs";
import { spawnSync } from "node:child_process";
import { loadSessionState, sessionStatsSummary, lifetimeStats } from "../lib/savings.mjs";
import { compactNumber, plainCount, durationMs, money } from "../lib/format.mjs";

// ANSI colors (truecolor)
const BRAND_GREEN = "\x1b[38;2;147;232;73m";
const DIM_GREEN = "\x1b[38;2;90;158;31m";
const GRAY = "\x1b[38;2;140;140;140m";
const YELLOW = "\x1b[38;2;230;190;60m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const EMOJI = "💾";
const BRAND = `${EMOJI} ${BRAND_GREEN}TOKENSAVER${RESET}`;

const TIPS = [
  "Ask \"how much has tokenSaver saved me?\" for a breakdown of time, tokens and money saved",
  "Ask me to recall past sessions — \"how did we fix that bug last week?\"",
  "Use the Sql tool to explore and understand your database schema without reading SQL files",
  "Ask \"is tokenSaver working?\" to run its doctor self-check",
  "Sql connects to live databases — query real data while you code",
];

// Segments take turns on the clock; registration sets refreshInterval to the
// same period so the line keeps rotating while the session is idle.
const ROTATE_SECONDS = 20;

// Cost heuristic, not a quality threshold (no published one exists): every
// turn re-reads the whole context from cache, so per-turn cost grows with it.
// 200K sits below the measured median (215K, REPORT-UTILIZZO.md §5bis); the
// advice is to compact at a natural breakpoint, not mid-implementation.
const CONTEXT_WARN_TOKENS = 200_000;

function sessionSegment(stats) {
  return (
    `${BRAND} est. session savings: ${DIM_GREEN}${money(stats.costSavedInUsd)}${RESET}` +
    ` · ${DIM_GREEN}${compactNumber(stats.tokensSaved)} tokens${RESET}` +
    ` · ${DIM_GREEN}${durationMs(stats.timeSavedInMs)}${RESET}` +
    ` · ${DIM_GREEN}${plainCount(stats.callsSaved)} roundtrips${RESET}  `
  );
}

function lifetimeSegment(lt) {
  return (
    `${BRAND} lifetime savings: ${DIM_GREEN}${money(lt.costSavedInUsd)}${RESET}` +
    ` · ${DIM_GREEN}${plainCount(lt.callsSaved)} roundtrips${RESET}` +
    ` · ${DIM_GREEN}~${durationMs(lt.timeSavedInMs)}${RESET}` +
    ` across ${DIM_GREEN}${lt.sessionCount} sessions${RESET}  `
  );
}

function tipSegment(turnCount) {
  return `${BRAND} ${GRAY}TIP: ${TIPS[turnCount % TIPS.length]}${RESET}  `;
}

const raw = await readStdinJson();
let input;
try {
  input = JSON.parse(raw);
} catch {}
const sessionId = input?.session_id;
const settings = loadSettings();
if (settings.enabled === false) process.exit(0);

// If we replaced a pre-existing status line on registration, chain to it:
// run its command with the same stdin and prepend its output to our segment,
// so the user's own status line keeps working alongside tokenSaver's.
let prevOutput;
function previousStatusLineOutput() {
  if (prevOutput !== undefined) return prevOutput;
  prevOutput = "";
  const prev = settings.previousStatusLine;
  const cmd = prev?.type === "command" ? prev.command : undefined;
  if (typeof cmd !== "string" || cmd.includes("status-line.cjs")) return prevOutput;
  try {
    const res = spawnSync(cmd, {
      input: raw,
      shell: true,
      timeout: 1500,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (res.status === 0 && typeof res.stdout === "string") {
      prevOutput = res.stdout.replace(/\n+$/, "");
      if (prevOutput) prevOutput += "\n";
    }
  } catch {}
  return prevOutput;
}

let contextWarning = "";
const done = (text) => {
  process.stdout.write(previousStatusLineOutput() + text + contextWarning);
  process.exit(0);
};

if (sessionId == null) {
  done(sessionSegment({ costSavedInUsd: 0, tokensSaved: 0, timeSavedInMs: 0, callsSaved: 0 }));
}

const state = loadSessionState(sessionId);
const stats = sessionStatsSummary(state);

const contextTokens = state.parent.lastContextTokens ?? 0;
if (settings.statusLineContextWarning && contextTokens >= CONTEXT_WARN_TOKENS) {
  contextWarning = `${YELLOW}⚠ context ${compactNumber(contextTokens)} re-read every turn — compact at the next milestone${RESET}  `;
}

const segments = [];
if (settings.statusLineSession) segments.push("savings");
if (settings.statusLineLifetime) segments.push("lifetime");
if (settings.statusLineTips) segments.push("tip");

if (stats.totalSaverCalls > 0 && segments.length > 0) {
  // TOKENSAVER_STATUS_NOW_MS pins the clock for tests.
  const nowMs = Number(process.env.TOKENSAVER_STATUS_NOW_MS) || Date.now();
  const slot = Math.floor(nowMs / (ROTATE_SECONDS * 1000));
  const picked = segments[slot % segments.length];
  // Advance the tip once per full rotation so every tip gets its turn.
  if (picked === "tip") done(tipSegment(Math.floor(slot / segments.length)));
  if (picked === "lifetime") {
    const lt = lifetimeStats();
    if (lt.costSavedInUsd > 0) done(lifetimeSegment(lt));
  }
  // "savings" and unrenderable picks fall through to the session segment.
}

// Nothing saved yet in this session: a tip beats a row of zeros.
if (stats.totalSaverCalls === 0 && settings.statusLineTips) {
  done(tipSegment(state.usage.turnCount));
}

if (settings.statusLineSession) {
  done(sessionSegment(stats));
}
done(`${DIM}${EMOJI} TOKENSAVER${RESET}  `);
