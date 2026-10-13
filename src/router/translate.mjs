// Wire-protocol translation between the Anthropic Messages API (what Claude
// Code speaks on /v1/messages) and OpenAI-compatible upstreams, in both
// "chat-completions" and "responses" api styles. Both directions plus the
// SSE stream rewrite are implemented here.

// ---------- inbound: Anthropic Messages -> OpenAI chat.completions ----------

function textOfBlocks(blocks) {
  return (blocks ?? [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

function anthropicContentToOpenAiParts(blocks) {
  const parts = [];
  for (const b of blocks ?? []) {
    if (b?.type === "text") parts.push({ type: "text", text: b.text ?? "" });
    else if (b?.type === "image" && b.source?.type === "base64") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
      });
    } else if (b?.type === "image" && b.source?.type === "url") {
      parts.push({ type: "image_url", image_url: { url: b.source.url } });
    }
  }
  return parts;
}

// One Anthropic message may become several OpenAI messages (tool_result
// blocks each become their own role:"tool" message).
function anthropicMessageToChatCompletions(msg) {
  const out = [];
  const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
  if (msg.role === "assistant") {
    const toolCalls = blocks.filter((b) => b?.type === "tool_use").map((b, i) => ({
      id: b.id ?? `call_${i}`,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
    const text = textOfBlocks(blocks);
    out.push({
      role: "assistant",
      content: text === "" && toolCalls.length > 0 ? null : text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
    return out;
  }
// Non-text tool_result content (e.g. an image-only result) becomes a compact
// placeholder — JSON.stringify would dump megabytes of base64 into the prompt.
function blockSummary(content) {
  if (!Array.isArray(content) || content.length === 0) return "";
  return `[${content.map((b) => b?.type ?? "block").join(", ")}]`;
}

  // user role: tool_result blocks turn into separate tool messages first.
  const results = blocks.filter((b) => b?.type === "tool_result");
  for (const r of results) {
    const content =
      typeof r.content === "string"
        ? r.content
        : textOfBlocks(r.content) || blockSummary(r.content);
    out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.is_error ? `Error: ${content}` : content });
  }
  const rest = blocks.filter((b) => b?.type !== "tool_result");
  if (rest.length > 0 || results.length === 0) {
    const parts = anthropicContentToOpenAiParts(rest);
    out.push({
      role: "user",
      content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
    });
  }
  return out;
}

function anthropicToolsToChatCompletions(tools) {
  return (tools ?? [])
    .filter((t) => t?.name)
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
}

function anthropicToolChoiceToOpenAi(choice) {
  if (choice == null) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
    default:
      return undefined;
  }
}

function systemToText(system) {
  if (system == null) return undefined;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return textOfBlocks(system);
  return undefined;
}

export function anthropicToChatCompletions(body) {
  const messages = [];
  const sys = systemToText(body.system);
  if (sys != null && sys !== "") messages.push({ role: "developer", content: sys });
  for (const m of body.messages ?? []) messages.push(...anthropicMessageToChatCompletions(m));
  const out = {
    model: body.model,
    messages,
    max_completion_tokens: body.max_tokens,
    stream: body.stream === true,
  };
  if (out.stream) out.stream_options = { include_usage: true };
  const tools = anthropicToolsToChatCompletions(body.tools);
  if (tools.length > 0) out.tools = tools;
  const tc = anthropicToolChoiceToOpenAi(body.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  // Anthropic thinking budgets map onto OpenAI reasoning effort tiers.
  if (body.thinking?.type === "enabled") {
    const budget = body.thinking.budget_tokens ?? 0;
    out.reasoning_effort = budget >= 32000 ? "high" : budget >= 8000 ? "medium" : "low";
  } else if (body.thinking?.type === "disabled") {
    out.reasoning_effort = "none";
  }
  return out;
}

// ---------- inbound: Anthropic Messages -> OpenAI Responses API ----------

function anthropicMessageToResponsesItems(msg) {
  const items = [];
  const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
  if (msg.role === "assistant") {
    const text = textOfBlocks(blocks);
    if (text !== "") {
      items.push({ role: "assistant", content: [{ type: "output_text", text }] });
    }
    for (const b of blocks.filter((x) => x?.type === "tool_use")) {
      items.push({
        type: "function_call",
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      });
    }
    return items;
  }
  const results = blocks.filter((b) => b?.type === "tool_result");
  for (const r of results) {
    const output =
      typeof r.content === "string"
        ? r.content
        : textOfBlocks(r.content) || blockSummary(r.content);
    items.push({ type: "function_call_output", call_id: r.tool_use_id, output: r.is_error ? `Error: ${output}` : output });
  }
  const rest = blocks.filter((b) => b?.type !== "tool_result");
  if (rest.length > 0 || results.length === 0) {
    const parts = [];
    for (const b of rest) {
      if (b?.type === "text") parts.push({ type: "input_text", text: b.text ?? "" });
      else if (b?.type === "image" && b.source?.type === "base64") {
        parts.push({ type: "input_image", image_url: `data:${b.source.media_type};base64,${b.source.data}` });
      } else if (b?.type === "image" && b.source?.type === "url") {
        parts.push({ type: "input_image", image_url: b.source.url });
      }
    }
    items.push({ role: "user", content: parts });
  }
  return items;
}

export function anthropicToResponses(body) {
  const input = [];
  for (const m of body.messages ?? []) input.push(...anthropicMessageToResponsesItems(m));
  const out = {
    model: body.model,
    input,
    stream: body.stream === true,
  };
  const sys = systemToText(body.system);
  if (sys != null && sys !== "") out.instructions = sys;
  if (body.max_tokens != null) out.max_output_tokens = body.max_tokens;
  const tools = anthropicToolsToChatCompletions(body.tools).map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
  if (tools.length > 0) out.tools = tools;
  const tc = anthropicToolChoiceToOpenAi(body.tool_choice);
  if (tc !== undefined) {
    out.tool_choice = tc === "required" ? "required" : tc;
  }
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.thinking?.type === "enabled") {
    const budget = body.thinking.budget_tokens ?? 0;
    out.reasoning = { effort: budget >= 32000 ? "high" : budget >= 8000 ? "medium" : "low" };
  } else if (body.thinking?.type === "disabled") {
    out.reasoning = { effort: "none" };
  }
  return out;
}

// ---------- outbound: OpenAI -> Anthropic ----------

const FINISH_TO_STOP = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

export function chatCompletionToAnthropic(resp, model) {
  const choice = resp.choices?.[0];
  const msg = choice?.message ?? {};
  const content = [];
  if (typeof msg.content === "string" && msg.content !== "") content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input;
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  return {
    id: resp.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model ?? resp.model,
    content,
    stop_reason: FINISH_TO_STOP[choice?.finish_reason] ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

export function responsesToAnthropic(resp, model) {
  const content = [];
  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text !== "") content.push({ type: "text", text: part.text });
      }
    } else if (item.type === "function_call") {
      let input;
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: item.call_id ?? item.id, name: item.name, input });
    } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
      const text = item.summary.map((s) => s.text ?? "").join("\n");
      if (text !== "") content.push({ type: "thinking", thinking: text, signature: "" });
    }
  }
  return {
    id: resp.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model ?? resp.model,
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
    },
  };
}

// ---------- SSE stream rewrite: OpenAI chunks -> Anthropic events ----------
//
// Claude Code consumes `POST /v1/messages` with stream:true as an SSE stream
// of Anthropic events. This state machine turns OpenAI streaming chunks (both
// api styles) into that event sequence.

export function createStreamTranslator({ apiStyle, model }) {
  const blocks = new Map(); // index -> {kind:"text"|"tool_use", started, closed, tool:{id,name}}
  let nextBlockIndex = 0;
  let messageStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = null;
  const events = [];

  const emit = (event, data) => events.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function ensureMessageStart(firstChunk) {
    if (messageStarted) return;
    messageStarted = true;
    emit("message_start", {
      type: "message_start",
      message: {
        id: firstChunk?.id ?? firstChunk?.response?.id ?? `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: model ?? firstChunk?.model ?? firstChunk?.response?.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    });
  }

  function startBlock(kind, tool) {
    const idx = nextBlockIndex++;
    const block =
      kind === "text"
        ? { type: "text", text: "" }
        : { type: "tool_use", id: tool?.id ?? `toolu_${idx}`, name: tool?.name ?? "", input: {} };
    blocks.set(idx, { kind, tool });
    emit("content_block_start", { type: "content_block_start", index: idx, content_block: block });
    return idx;
  }

  function stopBlock(idx) {
    emit("content_block_stop", { type: "content_block_stop", index: idx });
    const b = blocks.get(idx);
    if (b) b.closed = true;
  }

  function textDelta(idx, text) {
    if (text == null || text === "") return;
    emit("content_block_delta", {
      type: "content_block_delta",
      index: idx,
      delta: { type: "text_delta", text },
    });
  }

  function toolArgsDelta(idx, partialJson) {
    if (partialJson == null || partialJson === "") return;
    emit("content_block_delta", {
      type: "content_block_delta",
      index: idx,
      delta: { type: "input_json_delta", partial_json: partialJson },
    });
  }

  function finish() {
    for (const [idx, b] of blocks) if (!b.closed) stopBlock(idx);
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason ?? (anyToolUse() ? "tool_use" : "end_turn"), stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    emit("message_stop", { type: "message_stop" });
  }

  function anyToolUse() {
    for (const b of blocks.values()) if (b.kind === "tool_use") return true;
    return false;
  }

  // --- chat-completions chunk handling ---
  // Track tool_calls by their OpenAI-side index -> our block index.
  const toolCallIndex = new Map();

  function handleChatChunk(chunk) {
    ensureMessageStart(chunk);
    const choice = chunk.choices?.[0];
    if (choice == null) {
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }
      return;
    }
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content !== "") {
      if (blocks.size === 0 || ![...blocks.values()].at(-1) || [...blocks.values()].at(-1).kind !== "text") {
        startBlock("text");
      }
      textDelta(nextBlockIndex - 1, delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const key = tc.index ?? 0;
        if (!toolCallIndex.has(key)) {
          // Close any open text block before starting a tool block.
          const last = blocks.get(nextBlockIndex - 1);
          if (last && !last.closed) stopBlock(nextBlockIndex - 1);
          const idx = startBlock("tool_use", { id: tc.id, name: tc.function?.name });
          toolCallIndex.set(key, idx);
        }
        const idx = toolCallIndex.get(key);
        if (tc.function?.arguments) toolArgsDelta(idx, tc.function.arguments);
      }
    }
    if (choice.finish_reason != null) {
      stopReason = FINISH_TO_STOP[choice.finish_reason] ?? stopReason;
    }
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
  }

  // --- responses-api chunk handling ---
  // Events: response.output_text.delta {item_id, output_index, content_index, delta}
  //         response.function_call_arguments.delta {item_id, output_index, delta}
  //         response.output_item.added {item:{type:"function_call",call_id,name}}
  //         response.completed {response:{usage,...}}
  const responsesItemIndex = new Map(); // item_id -> block index

  function handleResponsesEvent(evt) {
    ensureMessageStart(evt.response ?? evt);
    const type = evt.type ?? "";
    if (type === "response.output_item.added") {
      const item = evt.item ?? {};
      if (item.type === "function_call") {
        const last = blocks.get(nextBlockIndex - 1);
        if (last && !last.closed) stopBlock(nextBlockIndex - 1);
        const idx = startBlock("tool_use", { id: item.call_id ?? item.id, name: item.name });
        responsesItemIndex.set(item.id ?? `item_${evt.output_index}`, idx);
      }
      return;
    }
    if (type === "response.output_text.delta") {
      const last = blocks.get(nextBlockIndex - 1);
      if (!last || last.kind !== "text") startBlock("text");
      textDelta(nextBlockIndex - 1, evt.delta);
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      const idx = responsesItemIndex.get(evt.item_id);
      if (idx != null) toolArgsDelta(idx, evt.delta);
      return;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const resp = evt.response ?? {};
      inputTokens = resp.usage?.input_tokens ?? inputTokens;
      outputTokens = resp.usage?.output_tokens ?? outputTokens;
      stopReason = (resp.output ?? []).some((i) => i.type === "function_call") ? "tool_use" : "end_turn";
      if (type === "response.incomplete") stopReason = "max_tokens";
    }
  }

  let buffer = "";

  return {
    // Feed raw upstream SSE text; returns Anthropic-formatted SSE text.
    push(chunkText) {
      buffer += chunkText;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      for (const frame of frames) {
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        if (apiStyle === "responses") handleResponsesEvent(parsed);
        else handleChatChunk(parsed);
      }
      const out = events.slice();
      events.length = 0;
      return out.join("");
    },
    flush() {
      finish();
      const out = events.slice();
      events.length = 0;
      return out.join("");
    },
  };
}

// ---------- error shaping ----------

export function anthropicError(status, message, type = "api_error") {
  return {
    status,
    body: {
      type: "error",
      error: { type, message: typeof message === "string" ? message : JSON.stringify(message) },
    },
  };
}
