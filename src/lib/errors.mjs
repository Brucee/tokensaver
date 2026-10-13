// MCP result builders shared by all tools.

export function mcpText(text) {
  return { content: [{ type: "text", text }] };
}

export function mcpError(text, errorCode) {
  const out = {
    isError: true,
    content: [{ type: "text", text }],
  };
  if (errorCode != null) out._meta = { errorCode };
  return out;
}

export function mcpImage(base64, mediaType) {
  return { content: [{ type: "image", data: base64, mimeType: mediaType }] };
}
