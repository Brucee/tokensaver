#!/usr/bin/env node
// tokenSaver router daemon — loopback HTTP proxy that lets Claude Code talk
// to non-Anthropic providers. Claude Code is pointed at
// http://127.0.0.1:<port>/router-preset/<preset> via ANTHROPIC_BASE_URL; this
// daemon maps the preset to a provider, rewrites the request (model
// mappings + declarative request modifications), translates the wire
// protocol when needed, and streams the reply back in Anthropic shape.
import http from "node:http";
import { loadRouterConfig, presetForPath, selectProvider, resolveModel, ROUTER_PRESET_PREFIX } from "../src/router/config.mjs";
import { applyRequestModifications } from "../src/router/modifications.mjs";
import {
  anthropicToChatCompletions,
  anthropicToResponses,
  chatCompletionToAnthropic,
  responsesToAnthropic,
  createStreamTranslator,
  anthropicError,
} from "../src/router/translate.mjs";
import { writeRouterState, clearRouterState } from "../src/router/state.mjs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const LISTEN_HOST = process.env.TOKENSAVER_ROUTER_LISTEN_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.TOKENSAVER_ROUTER_PORT ?? "0") || 0;
const DEFAULT_TIMEOUT_MS = 300_000;

// ---------- helpers ----------

const MAX_BODY_BYTES = 32 * 1024 * 1024; // image-heavy requests are large but bounded

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body exceeds 32 MiB"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendAnthropicError(res, status, message, type = "api_error") {
  const shaped = anthropicError(status, message, type);
  sendJson(res, shaped.status, shaped.body);
}

// Headers allowed to flow to the upstream provider. Everything else
// (host, connection, content-length) is rebuilt by fetch.
const PASSTHROUGH_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "content-type",
  "accept",
]);

function outboundHeaders(inbound, { passThroughAuth, apiKey, openai }) {
  const headers = { "content-type": "application/json" };
  if (passThroughAuth) {
    for (const [k, v] of Object.entries(inbound)) {
      if (PASSTHROUGH_HEADERS.has(k)) headers[k] = v;
    }
  }
  if (apiKey && openai) headers["authorization"] = `Bearer ${apiKey}`;
  else if (apiKey) headers["x-api-key"] = apiKey;
  return headers;
}

function joinUrl(base, path) {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

// ---------- per-request handling ----------

function transportFor(provider) {
  if (provider?.transports?.anthropic) return { kind: "anthropic", config: provider.transports.anthropic };
  if (provider?.transports?.openai) {
    const t = provider.transports.openai;
    return { kind: "openai", config: t, apiStyle: t?.modelConfig?.apiStyle === "responses" ? "responses" : "chat-completions" };
  }
  return null;
}

async function handleMessages(req, res, { preset, provider, config, presetPath, inboundHeaders, anthropicBody, endpoint }) {
  const transport = transportFor(provider);
  if (transport == null) {
    return sendAnthropicError(res, 502, `provider "${provider?.id}" has no usable transport`, "invalid_request_error");
  }

  // Model mapping (preset-level wins over provider-level).
  anthropicBody.model = resolveModel(config, preset, provider, anthropicBody.model);

  // Declarative request modifications (preset first, then transport-level).
  const headers = applyRequestModifications(
    [...(preset.requestModifications ?? []), ...(transport.config?.requestModifications ?? [])],
    { headers: outboundHeaders(inboundHeaders, { passThroughAuth: preset.passThroughAuth === true, apiKey: provider.apiKey, openai: transport.kind === "openai" }), body: anthropicBody, presetPath },
  );

  const timeoutMs = provider.timeoutInMs ?? DEFAULT_TIMEOUT_MS;

  if (transport.kind === "anthropic") {
    const upstream = await fetch(joinUrl(provider.baseUrl, endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch {}
    return res.end();
  }

  // openai transport
  const isCountTokens = endpoint.endsWith("count_tokens");
  if (isCountTokens) {
    // No OpenAI equivalent — approximate 4 chars/token over the message text.
    const text = JSON.stringify(anthropicBody.messages ?? []);
    return sendJson(res, 200, { input_tokens: Math.ceil(text.length / 4) });
  }

  const apiStyle = transport.apiStyle;
  const upstreamBody = apiStyle === "responses" ? anthropicToResponses(anthropicBody) : anthropicToChatCompletions(anthropicBody);
  const upstream = await fetch(joinUrl(provider.baseUrl, apiStyle === "responses" ? "responses" : "chat/completions"), {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    return sendAnthropicError(res, upstream.status, errText.slice(0, 2000) || upstream.statusText);
  }

  const model = anthropicBody.model;
  if (anthropicBody.stream === true) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const translator = createStreamTranslator({ apiStyle, model });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const out = translator.push(decoder.decode(value, { stream: true }));
        if (out) res.write(out);
      }
    } catch {}
    res.write(translator.flush());
    return res.end();
  }

  const json = await upstream.json();
  const translated = apiStyle === "responses" ? responsesToAnthropic(json, model) : chatCompletionToAnthropic(json, model);
  sendJson(res, 200, translated);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { status: "ok", pid: process.pid, startedAt: STARTED_AT });
    }
    if (req.method !== "POST" || !url.pathname.startsWith(ROUTER_PRESET_PREFIX)) {
      return sendAnthropicError(res, 404, `unsupported route ${req.method} ${url.pathname}`, "not_found_error");
    }
    // Loopback is reachable by every browser tab: refuse DNS-rebinding (Host
    // that isn't loopback) and cross-origin pages (Origin not loopback, or
    // fetch metadata only browsers send). The daemon injects real API keys,
    // so "any page on the web" must not be able to spend them.
    const hostHeader = req.headers.host ?? "";
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(hostHeader)) {
      return sendAnthropicError(res, 403, "refused: Host header is not loopback", "permission_error");
    }
    const origin = req.headers.origin;
    if ((origin != null && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) || req.headers["sec-fetch-site"] != null) {
      return sendAnthropicError(res, 403, "refused: cross-origin request", "permission_error");
    }
    // /router-preset/<presetPath>/<endpoint> — presetPath itself starts with "/".
    const rest = url.pathname.slice(ROUTER_PRESET_PREFIX.length);
    const v1 = rest.indexOf("/v1/");
    if (v1 < 0) return sendAnthropicError(res, 404, `missing /v1/ in ${url.pathname}`, "not_found_error");
    const presetPath = rest.slice(0, v1) || "/";
    const endpoint = rest.slice(v1 + 1); // "v1/messages", "v1/messages/count_tokens"

    const config = loadRouterConfig();
    const preset = presetForPath(config, presetPath);
    if (preset == null) return sendAnthropicError(res, 404, `unknown preset "${presetPath}"`, "not_found_error");

    const inboundHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) inboundHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
    const provider = selectProvider(config, preset, inboundHeaders);
    if (provider == null) return sendAnthropicError(res, 502, `no provider resolvable for preset "${presetPath}"`, "api_error");

    const raw = await readBody(req);
    let anthropicBody;
    try {
      anthropicBody = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      return sendAnthropicError(res, 400, "invalid JSON body", "invalid_request_error");
    }

    await handleMessages(req, res, { preset, provider, config, presetPath, inboundHeaders, anthropicBody, endpoint });
  } catch (e) {
    if (!res.headersSent) sendAnthropicError(res, 500, e?.message ?? String(e));
    else res.end();
  }
});

const STARTED_AT = new Date().toISOString();

if (!LOOPBACK.has(LISTEN_HOST)) {
  console.error(
    `Refusing to start: TOKENSAVER_ROUTER_LISTEN_HOST is set to a non-loopback address "${LISTEN_HOST}".\n` +
      "This daemon replays user credentials — binding on a public interface is not supported. Unset it or use 127.0.0.1.",
  );
  process.exit(1);
}

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const addr = server.address();
  writeRouterState({ pid: process.pid, listenerPort: addr.port, host: LISTEN_HOST, startedAt: STARTED_AT });
  console.log(`tokenSaver router daemon listening on http://${LISTEN_HOST}:${addr.port} (pid ${process.pid})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearRouterState();
    server.close(() => process.exit(0));
  });
}
process.on("exit", () => clearRouterState());
