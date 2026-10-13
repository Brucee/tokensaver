#!/usr/bin/env node
// tokensaver — plugin CLI: local-only status, settings, recall, doctor.
// No network, no auth, no telemetry.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const COMMANDS = ["status", "savings", "settings", "recall", "review-diff", "review-verify", "router", "doctor", "help"];

function usage() {
  return [
    "Usage: tokensaver <command> [options]",
    "",
    "Commands:",
    "  status              Plugin status: version, data dir, settings, lifetime savings",
    "  savings             Savings stats (session with --session <id>, else lifetime)",
    "  settings            --show | --set <key> <value>",
    "  recall <query>      Search prior session transcripts (see: tokensaver recall --help)",
    "  review-diff         Print the diff bundle for code review [--base <ref>] [--meta]",
    "  review-verify       Verify review findings' file:line citations [findings-file|stdin]",
    "  router              Loopback router: activate [preset] | deactivate | status | daemon",
    "  doctor              Check the install: runtime, data dir, hooks, MCP server",
    "  help                This message",
  ].join("\n");
}

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function cmdStatus() {
  const { tokensaverHome, loadSettings } = await import("../src/lib/config.mjs");
  const { lifetimeStats } = await import("../src/lib/savings.mjs");
  const settings = loadSettings();
  const life = lifetimeStats();
  const out = {
    plugin: "tokensaver",
    version: pluginVersion(),
    node: process.version,
    home: tokensaverHome(),
    enabled: settings.enabled,
    lifetime: {
      sessionCount: life.sessionCount,
      callsSaved: life.callsSaved,
      tokensSaved: life.tokensSaved,
      costSavedInUsd: life.costSavedInUsd,
      timeSavedInMs: life.callsSaved * 25000,
    },
    settings,
  };
  console.log(JSON.stringify(out, null, 2));
}

async function cmdSavings(argv) {
  const { lifetimeStats, loadSessionState, sessionStatsSummary } = await import("../src/lib/savings.mjs");
  const i = argv.indexOf("--session");
  const sessionId = i >= 0 ? argv[i + 1] : process.env.CLAUDE_CODE_SESSION_ID;
  if (sessionId) {
    const state = loadSessionState(sessionId);
    console.log(JSON.stringify({ scope: "session", sessionId, ...sessionStatsSummary(state) }, null, 2));
  } else {
    console.log(JSON.stringify({ scope: "lifetime", ...lifetimeStats() }, null, 2));
  }
}

async function cmdSettings(argv) {
  // delegate to settings-helper preserving its interface (--show / --set)
  const m = await import("../src/cli/settings-helper.mjs?args=" + encodeURIComponent(JSON.stringify(argv)));
}

async function cmdReviewDiff(argv) {
  const { collectReviewBundle, formatReviewBundle } = await import("../src/lib/review-diff.mjs");
  const i = argv.indexOf("--base");
  const base = i >= 0 ? argv[i + 1] : undefined;
  const bundle = collectReviewBundle({ base });
  if (argv.includes("--meta")) {
    const { committed, staged, unstaged, untracked, ...meta } = bundle;
    console.log(JSON.stringify(meta, null, 2));
  } else {
    console.log(formatReviewBundle(bundle));
  }
  if (!bundle.ok) process.exit(1);
}

async function cmdReviewVerify(argv) {
  const { verifyFindings } = await import("../src/lib/review-verify.mjs");
  const file = argv[0];
  const input = file && existsSync(file)
    ? readFileSync(file, "utf8")
    : await new Promise((res) => {
        let d = "";
        process.stdin.on("data", (c) => (d += c)).on("end", () => res(d));
      });
  console.log(JSON.stringify(verifyFindings(input), null, 2));
}

function cmdRecall(argv) {
  const target = join(PLUGIN_ROOT, "scripts", "recall.cjs");
  const res = spawnSync(process.execPath, [target, ...argv], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

async function cmdRouter(argv) {
  const { routerActivate, routerDeactivate, routerStatus } = await import("../src/cli/router.mjs");
  const sub = argv[0] ?? "status";
  if (sub === "activate") {
    const preset = argv[1] ?? "/claudecode";
    const res = await routerActivate(preset.startsWith("/") ? preset : `/${preset}`);
    if (!res.ok) {
      console.error(res.error);
      process.exit(1);
    }
    console.log(`Router active: ANTHROPIC_BASE_URL → ${res.url}`);
    console.log("Start a new Claude Code session to route through it. `tokensaver router deactivate` to revert.");
    return;
  }
  if (sub === "deactivate") {
    const res = routerDeactivate();
    console.log(res.changed ? "Router deactivated: ANTHROPIC_BASE_URL restored." : "Router was not active.");
    return;
  }
  if (sub === "status") {
    console.log(JSON.stringify(await routerStatus(), null, 2));
    return;
  }
  if (sub === "daemon") {
    // Foreground run for debugging — state file + port are written as usual.
    const m = await import("../servers/router-daemon.mjs");
    return;
  }
  console.error('Usage: tokensaver router activate [preset] | deactivate | status | daemon');
  process.exit(2);
}

async function cmdDoctor() {
  const checks = [];
  const ok = (name, pass, detail) => checks.push({ check: name, ok: !!pass, ...(detail ? { detail } : {}) });

  const [maj, min] = process.versions.node.split(".").map(Number);
  ok("node>=22.16", maj > 22 || (maj === 22 && min >= 16), process.versions.node);

  const { tokensaverHome, ensureHome } = await import("../src/lib/config.mjs");
  const home = ensureHome();
  ok("data-dir", existsSync(home), home);
  try {
    const probe = join(home, ".doctor-probe");
    writeFileSync(probe, "x");
    statSync(probe);
    ok("data-dir-writable", true);
  } catch (e) {
    ok("data-dir-writable", false, e.message);
  }

  ok("plugin-manifest", existsSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")));
  ok("mcp-server", existsSync(join(PLUGIN_ROOT, "servers", "code-server.mjs")));
  ok("hooks-json", existsSync(join(PLUGIN_ROOT, "hooks", "hooks.json")));
  ok("session-hook", existsSync(join(PLUGIN_ROOT, "scripts", "session-hook.cjs")));
  ok("recall-cli", existsSync(join(PLUGIN_ROOT, "scripts", "recall.cjs")));
  ok("router-config", existsSync(join(PLUGIN_ROOT, "router-config.jsonc")));
  ok("router-daemon", existsSync(join(PLUGIN_ROOT, "servers", "router-daemon.mjs")));
  ok("agents", ["code", "explore", "recall"].every((a) => existsSync(join(PLUGIN_ROOT, "agents", a + ".md"))));

  const { loadSettings } = await import("../src/lib/config.mjs");
  const { getHost } = await import("../src/host/index.mjs");
  if (getHost().capabilities.statusLine && loadSettings().statusLine) {
    let registered = false;
    try {
      const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".claude");
      const installed = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
      registered = JSON.stringify(installed.statusLine ?? {}).includes("tokensaver");
    } catch {}
    ok("statusline-registered", registered, "checked ~/.claude/settings.json statusLine");
  }

  const failures = checks.filter((c) => !c.ok).length;
  console.log(JSON.stringify({ ok: failures === 0, failures, checks }, null, 2));
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd == null || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    process.exit(cmd == null ? 2 : 0);
  }
  const rest = argv.slice(1);
  switch (cmd) {
    case "status":
      return cmdStatus();
    case "savings":
      return cmdSavings(rest);
    case "settings":
      // settings-helper reads process.argv — splice ours in
      process.argv = [process.argv[0], process.argv[1], ...rest];
      return cmdSettings(rest);
    case "recall":
      return cmdRecall(rest);
    case "review-diff":
      return cmdReviewDiff(rest);
    case "review-verify":
      return cmdReviewVerify(rest);
    case "router":
      return cmdRouter(rest);
    case "doctor":
      return cmdDoctor();
    default:
      console.error('Unknown command "' + cmd + '". Expected one of: ' + COMMANDS.join(", ") + ".\n\n" + usage());
      process.exit(2);
  }
}

main().catch((e) => {
  console.error("tokensaver: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
