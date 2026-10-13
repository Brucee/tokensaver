import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { stripJsonc, parseJsonc, interpolateEnv, wildcardMatch: _w, mapModel, resolveModel, presetForPath, selectProvider, loadRouterConfig } = await import(
  new URL("../src/router/config.mjs", import.meta.url).href
);
const { anthropicToChatCompletions, anthropicToResponses, chatCompletionToAnthropic, responsesToAnthropic, createStreamTranslator } = await import(
  new URL("../src/router/translate.mjs", import.meta.url).href
);
const { applyRequestModifications } = await import(new URL("../src/router/modifications.mjs", import.meta.url).href);

// ---------- config ----------

test("stripJsonc removes comments and trailing commas", () => {
  const out = stripJsonc('{ "a": 1, // hi\n /* x */ "b": "s://x", }');
  assert.deepEqual(JSON.parse(out), { a: 1, b: "s://x" });
});

test("parseJsonc drops $id-only placeholders", () => {
  const cfg = parseJsonc('{ "routingPresets": [ { "path": "/x", "requestModifications": [ { "$id": "slot" }, { "tools": [] } ] } ] }');
  assert.equal(cfg.routingPresets[0].requestModifications.length, 1);
});

test("interpolateEnv resolves ${VAR} and ${VAR:-default}", () => {
  assert.equal(interpolateEnv("a-${FOO}-b", { FOO: "X" }), "a-X-b");
  assert.equal(interpolateEnv("a-${MISSING:-d}-b", {}), "a-d-b");
});

test("mapModel honors wildcard tier slugs, first match wins", () => {
  const m = [
    { model: "*haiku*", target: "gpt-mini" },
    { model: "*opus*", target: "gpt-max" },
  ];
  assert.equal(mapModel(m, "claude-haiku-5-5"), "gpt-mini");
  assert.equal(mapModel(m, "claude-opus-5-5"), "gpt-max");
  assert.equal(mapModel(m, "claude-sonnet-5-5"), "claude-sonnet-5-5");
});

test("resolveModel: preset mappings override provider mappings", () => {
  const preset = { modelMappings: [{ model: "sonnet", target: "claude-sonnet-5-5" }] };
  const provider = { modelMappings: [{ model: "*sonnet*", target: "gpt-5.4" }] };
  assert.equal(resolveModel({}, preset, provider, "sonnet"), "claude-sonnet-5-5");
  assert.equal(resolveModel({}, {}, provider, "claude-sonnet-5-5"), "gpt-5.4");
});

// ---------- translate: anthropic -> openai ----------

const ANTH_REQ = {
  model: "claude-sonnet-5-5",
  max_tokens: 1024,
  system: [{ type: "text", text: "You are helpful." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "toolu_1", name: "Search", input: { content_regex: "foo" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "found it" }] },
        { type: "text", text: "and now?" },
      ],
    },
  ],
  tools: [{ name: "Search", description: "search files", input_schema: { type: "object", properties: { content_regex: { type: "string" } } } }],
  tool_choice: { type: "auto" },
  thinking: { type: "enabled", budget_tokens: 16000 },
  stream: false,
};

test("anthropicToChatCompletions maps system/messages/tools/tool_results", () => {
  const out = anthropicToChatCompletions(ANTH_REQ);
  assert.equal(out.model, "claude-sonnet-5-5");
  assert.equal(out.max_completion_tokens, 1024);
  assert.equal(out.messages[0].role, "developer");
  assert.equal(out.messages[0].content, "You are helpful.");
  assert.equal(out.messages[2].role, "assistant");
  assert.equal(out.messages[2].tool_calls[0].function.name, "Search");
  assert.deepEqual(JSON.parse(out.messages[2].tool_calls[0].function.arguments), { content_regex: "foo" });
  const toolMsg = out.messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "toolu_1");
  assert.equal(toolMsg.content, "found it");
  assert.equal(out.tools[0].function.parameters.properties.content_regex.type, "string");
  assert.equal(out.reasoning_effort, "medium");
});

test("anthropicToResponses maps to instructions/input/function_call items", () => {
  const out = anthropicToResponses(ANTH_REQ);
  assert.equal(out.instructions, "You are helpful.");
  assert.equal(out.max_output_tokens, 1024);
  assert.equal(out.reasoning.effort, "medium");
  const call = out.input.find((i) => i.type === "function_call");
  assert.equal(call.call_id, "toolu_1");
  const callOut = out.input.find((i) => i.type === "function_call_output");
  assert.equal(callOut.output, "found it");
  assert.equal(out.tools[0].type, "function");
});

// ---------- translate: openai -> anthropic ----------

test("chatCompletionToAnthropic maps text+tool_calls and usage", () => {
  const resp = {
    id: "chatcmpl-1",
    model: "gpt-5.4",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "checking",
          tool_calls: [{ id: "call_9", type: "function", function: { name: "Edit", arguments: '{"edits":[]}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
  const out = chatCompletionToAnthropic(resp, "gpt-5.4");
  assert.equal(out.type, "message");
  assert.equal(out.stop_reason, "tool_use");
  assert.equal(out.content[1].type, "tool_use");
  assert.deepEqual(out.content[1].input, { edits: [] });
  assert.equal(out.usage.input_tokens, 11);
});

test("responsesToAnthropic maps output items", () => {
  const resp = {
    id: "resp_1",
    output: [
      { type: "message", content: [{ type: "output_text", text: "done" }] },
      { type: "function_call", call_id: "fc_1", name: "Search", arguments: '{"q":1}' },
    ],
    usage: { input_tokens: 5, output_tokens: 3 },
  };
  const out = responsesToAnthropic(resp, "gpt-5.5");
  assert.equal(out.content[0].text, "done");
  assert.equal(out.content[1].type, "tool_use");
  assert.equal(out.stop_reason, "tool_use");
  assert.equal(out.usage.output_tokens, 3);
});

// ---------- SSE stream rewrite ----------

test("stream translator emits a full Anthropic event sequence", () => {
  const t = createStreamTranslator({ apiStyle: "chat-completions", model: "gpt-5.4" });
  const chunks = [
    'data: {"id":"c1","choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"id":"c1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"id":"c1","choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Search","arguments":""}}]}}]}\n\n',
    'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]}}]}\n\n',
    'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
    'data: {"id":"c1","choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":8}}\n\n',
    "data: [DONE]\n\n",
  ];
  let sse = "";
  for (const c of chunks) sse += t.push(c);
  sse += t.flush();
  assert.match(sse, /event: message_start/);
  assert.match(sse, /"text_delta","text":"Hello"/);
  assert.match(sse, /"text_delta","text":" world"/);
  assert.match(sse, /"type":"tool_use","id":"call_1","name":"Search"/);
  assert.match(sse, /"input_json_delta","partial_json":"\{\\"q\\":"/);
  assert.match(sse, /"stop_reason":"tool_use"/);
  assert.match(sse, /event: message_stop/);
});

// ---------- request modifications ----------

test("applyRequestModifications strips headers/body and rewrites system prompt", () => {
  const headers = { "anthropic-beta": "a, b, c", "x-stainless-x": "1", authorization: "Bearer k" };
  const body = { system: [{ type: "text", text: "use rg and apply_patch" }], max_tokens: 5, temperature: 1 };
  const out = applyRequestModifications(
    [
      {
        headers: [
          { type: "remove", name: "x-stainless-*" },
          { type: "removeValues", name: "anthropic-beta", values: ["b"] },
        ],
        body: [{ type: "remove", path: "temperature" }],
        systemPrompt: [{ type: "edit", search: "rg and apply_patch", replace: "MCP tools" }],
      },
    ],
    { headers, body, presetPath: "/claudecode" },
  );
  assert.equal(out["x-stainless-x"], undefined);
  assert.equal(out["anthropic-beta"], "a, c");
  assert.equal(body.temperature, undefined);
  assert.equal(body.system[0].text, "use MCP tools");
});

test("modifications honor when.preset gating", () => {
  const body = { system: [{ type: "text", text: "x" }] };
  applyRequestModifications(
    [{ when: { preset: ["/other"] }, systemPrompt: [{ type: "append", text: "!" }] }],
    { headers: {}, body, presetPath: "/claudecode" },
  );
  assert.equal(body.system[0].text, "x");
});

// ---------- end-to-end: daemon + mock OpenAI upstream ----------

let daemon, mockUpstream, home, daemonPort, captured;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "ts-router-"));
  // Mock OpenAI upstream: echoes the translated request, returns a
  // chat.completion for non-stream, SSE chunks for stream.
  mockUpstream = createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    await new Promise((r) => req.on("end", r));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    captured = { url: req.url, headers: req.headers, body };
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"c1","choices":[{"delta":{"role":"assistant"}}]}\n\n');
      res.write('data: {"id":"c1","choices":[{"delta":{"content":"hi from openai"}}]}\n\n');
      res.write('data: {"id":"c1","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3}}\n\n');
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-x",
        model: body.model,
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 9, completion_tokens: 2 },
      }),
    );
  });
  await new Promise((r) => mockUpstream.listen(0, "127.0.0.1", r));
  const upstreamPort = mockUpstream.address().port;
  writeFileSync(
    join(home, "router-config.jsonc"),
    JSON.stringify({
      providers: [
        { id: "mock-openai", baseUrl: `http://127.0.0.1:${upstreamPort}/`, apiKey: "test-key", transports: { openai: {} } },
      ],
      routingPresets: [{ path: "/test", defaultProvider: "mock-openai" }],
    }),
  );
  daemon = spawn(process.execPath, [join(PLUGIN_ROOT, "servers", "router-daemon.mjs")], {
    env: { ...process.env, TOKENSAVER_HOME: home, TOKENSAVER_ROUTER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    daemon.stdout.on("data", (d) => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(d.toString());
      if (m) {
        daemonPort = Number(m[1]);
        resolve();
      }
    });
    daemon.on("exit", () => reject(new Error("daemon exited early")));
    setTimeout(() => reject(new Error("daemon start timeout")), 5000);
  });
});

after(() => {
  daemon?.kill();
  mockUpstream?.close();
  rmSync(home, { recursive: true, force: true });
});

test("e2e: anthropic request -> openai upstream -> anthropic json response", async () => {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/router-preset/test/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-inbound" },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 50,
      system: "be brief",
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.type, "message");
  assert.equal(json.content[0].text, "ok");
  assert.equal(json.usage.input_tokens, 9);
  // Upstream saw the OpenAI-shaped body with the mock api key.
  assert.equal(captured.url, "/chat/completions");
  assert.equal(captured.headers.authorization, "Bearer test-key");
  assert.equal(captured.body.max_completion_tokens, 50);
  assert.equal(captured.body.messages[0].role, "developer");
  assert.equal(captured.body.messages[1].content, "ping");
});

test("e2e: streaming responses get rewritten to Anthropic SSE", async () => {
  const res = await fetch(`http://127.0.0.1:${daemonPort}/router-preset/test/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", max_tokens: 5, stream: true, messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const sse = await res.text();
  assert.match(sse, /event: message_start/);
  assert.match(sse, /"text_delta","text":"hi from openai"/);
  assert.match(sse, /"stop_reason":"end_turn"/);
  assert.match(sse, /event: message_stop/);
});
