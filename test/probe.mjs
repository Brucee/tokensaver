#!/usr/bin/env node
// Smoke-test probe: spawn the MCP server, do initialize + tools/list.
// Usage: node test/probe.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "../servers/code-server.mjs");

const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
let buf = "";
const pending = new Map();
let nextId = 1;
const idFor = new Map();

child.stdout.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const request = (method, params = {}) =>
  new Promise((resolveP) => {
    const id = nextId++;
    pending.set(id, resolveP);
    send({ jsonrpc: "2.0", id, method, params });
  });

const notify = (method, params = {}) => send({ jsonrpc: "2.0", method, params });

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "tokensaver-probe", version: "0.0.1" },
});
console.error("initialize ->", JSON.stringify(init.result?.serverInfo));

notify("notifications/initialized");

const list = await request("tools/list");
const names = (list.result?.tools ?? []).map((t) => t.name);
console.log(JSON.stringify(names));
for (const t of list.result?.tools ?? []) {
  console.log(`  ${t.name}: ${Object.keys(t.inputSchema?.properties ?? {}).join(", ")}`);
}

child.kill();
process.exit(names.length === 3 ? 0 : 1);
