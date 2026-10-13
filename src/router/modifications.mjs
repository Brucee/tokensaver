// Declarative request modifications, applied to the inbound Anthropic-shaped
// request (headers + body) before provider translation. Shapes follow the
// router-config.jsonc spec:
//   headers:      {type:"remove",name:"anthropic-*"}
//                 {type:"removeValues",name:"anthropic-beta",values:[...]}
//                 {type:"add",name:"user-agent",value:"..."}
//   body:         {type:"remove",path:"max_tokens"}
//   systemPrompt: {type:"prepend"|"append",text} | {type:"edit",search,replace}
//   tools:        {type:"remove",name} | {type:"edit",tool,search,replace}
// Wildcards in search strings: ${*} = within a line, ${**} = across lines.

function wildcardSearchToRegex(search) {
  let re = "";
  let i = 0;
  while (i < search.length) {
    if (search.startsWith("${**}", i)) {
      re += "[\\s\\S]*?";
      i += 5;
    } else if (search.startsWith("${*}", i)) {
      re += "[^\\n]*?";
      i += 4;
    } else {
      re += search[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(re);
}

function headerNameMatches(name, pattern) {
  if (pattern.endsWith("*")) return name.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
  return name.toLowerCase() === pattern.toLowerCase();
}

function applyHeaderMods(headers, mods = []) {
  const out = { ...headers };
  for (const mod of mods) {
    if (mod.type === "remove") {
      for (const key of Object.keys(out)) if (headerNameMatches(key, mod.name)) delete out[key];
    } else if (mod.type === "removeValues") {
      for (const key of Object.keys(out)) {
        if (!headerNameMatches(key, mod.name)) continue;
        const keep = String(out[key])
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v !== "" && !(mod.values ?? []).includes(v));
        if (keep.length === 0) delete out[key];
        else out[key] = keep.join(", ");
      }
    } else if (mod.type === "add") {
      out[mod.name] = mod.value;
    }
  }
  return out;
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

function deletePath(obj, path) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o?.[keys[i]] == null) return;
    o = o[keys[i]];
  }
  delete o[keys[keys.length - 1]];
}

function applyBodyMods(body, mods = []) {
  for (const mod of mods) {
    if (mod.type === "remove") deletePath(body, mod.path);
    else if (mod.type === "set") setPath(body, mod.path, mod.value);
  }
}

// body.system may be a string or an array of {type:"text"} blocks.
function systemText(body) {
  if (typeof body.system === "string") return body.system;
  if (Array.isArray(body.system)) return body.system.map((b) => (b?.type === "text" ? b.text ?? "" : "")).join("");
  return "";
}

function setSystemText(body, text) {
  body.system = [{ type: "text", text }];
}

function applySystemPromptMods(body, mods = []) {
  let text = systemText(body);
  for (const mod of mods) {
    if (mod.type === "prepend") text = (mod.text ?? "") + text;
    else if (mod.type === "append") text = text + (mod.text ?? "");
    else if (mod.type === "edit" && typeof mod.search === "string") {
      text = text.replace(wildcardSearchToRegex(mod.search), mod.replace ?? "");
    }
  }
  setSystemText(body, text);
}

function applyToolMods(body, mods = []) {
  if (!Array.isArray(body.tools)) return;
  for (const mod of mods) {
    if (mod.type === "remove") {
      body.tools = body.tools.filter((t) => t?.name !== mod.name);
    } else if (mod.type === "edit") {
      for (const t of body.tools) {
        if (t?.name !== mod.tool || typeof t.description !== "string") continue;
        t.description = t.description.replace(wildcardSearchToRegex(mod.search), mod.replace ?? "");
      }
    }
  }
}

function modificationApplies(mod, presetPath) {
  const when = mod.when;
  if (when == null) return true;
  if (Array.isArray(when.preset)) return when.preset.includes(presetPath);
  return true;
}

// Apply all applicable modifications. `headers` is a plain object of inbound
// headers (lowercased keys); `body` is the parsed Anthropic request body
// (mutated in place). Returns the outgoing headers.
export function applyRequestModifications(mods, { headers, body, presetPath }) {
  let outHeaders = headers;
  for (const mod of mods ?? []) {
    if (mod == null || !modificationApplies(mod, presetPath)) continue;
    if (mod.headers) outHeaders = applyHeaderMods(outHeaders, mod.headers);
    if (mod.body) applyBodyMods(body, mod.body);
    if (mod.systemPrompt) applySystemPromptMods(body, mod.systemPrompt);
    if (mod.tools) applyToolMods(body, mod.tools);
  }
  return outHeaders;
}
