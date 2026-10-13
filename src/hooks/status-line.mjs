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
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const EMOJI = "💾";
const BRAND = `${EMOJI} ${BRAND_GREEN}TOKENSAVER${RESET}`;

const TIPS = [
  "Try /tokensaver-savings to see how much time, tokens, and money tokenSaver is saving you",
  "Ask me to recall past sessions — \"how did we fix that bug last week?\"",
  "Use the Sql tool to explore and understand your database schema without reading SQL files",
  "Run `tokensaver doctor` to check your tokenSaver setup",
  "Sql connects to live databases — query real data while you code",
];

const WEIGHTS = { savings: 6, reviewer: 2, baseline: 1, tip: 1, lifetime: 3 };

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

// Weighted rotation: expand each segment by its weight, index by turn count.
function pickSegment(turnCount, segments) {
  if (segments.length === 0) return "savings";
  if (segments.length === 1) return segments[0];
  const expanded = [];
  for (const seg of segments) {
    for (let i = 0; i < (WEIGHTS[seg] ?? 1); i++) expanded.push(seg);
  }
  return expanded[turnCount % expanded.length];
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

const done = (text) => {
  process.stdout.write(previousStatusLineOutput() + text);
  process.exit(0);
};

if (sessionId == null) {
  done(sessionSegment({ costSavedInUsd: 0, tokensSaved: 0, timeSavedInMs: 0, callsSaved: 0 }));
}

const state = loadSessionState(sessionId);
const stats = sessionStatsSummary(state);

const segments = [];
if (settings.statusLineSession) segments.push("savings");
if (settings.statusLineTips) segments.push("tip");
if (settings.statusLineLifetime) segments.push("lifetime");

if (stats.totalSaverCalls > 0 && segments.length > 0) {
  const turnCount = state.usage.turnCount;
  const picked = pickSegment(turnCount, segments);
  if (picked === "tip") done(tipSegment(turnCount));
  if (picked === "lifetime") {
    const lt = lifetimeStats();
    if (lt.costSavedInUsd > 0) done(lifetimeSegment(lt));
  }
  // "savings" and unrenderable picks fall through to the session segment.
}

if (settings.statusLineSession) {
  done(sessionSegment(stats));
}
done(`${DIM}${EMOJI} TOKENSAVER${RESET}  `);
