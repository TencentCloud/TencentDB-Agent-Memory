import type { ParsedCall } from "./types.js";

export function parseCurl(command: string): ParsedCall {
  try { return parseCurlArgs(shellWords(command), command); }
  catch (error) { return { command, protocol_valid: false, error: (error as Error).message }; }
}

/** Minimal shell lexing for legacy recorded single curl calls; never evaluates shell. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'" && i + 1 < command.length) {
      const next = command[++i];
      if (next !== "\n") { word += next; started = true; }
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else if (/[;&|`<>]/.test(char) || (char === "$" && command[i + 1] === "(")) {
      throw new Error("Shell operators are rejected");
    } else { word += char; started = true; }
  }
  if (quote) throw new Error("Unclosed shell quote");
  if (started) words.push(word);
  return words;
}

/** The workspace curl shim supplies argv after the real shell has parsed it. */
export function parseCurlArgs(argv: string[], command = argv.join(" ")): ParsedCall {
  const parsed: ParsedCall = { command, protocol_valid: false };
  if (argv[0]?.split("/").at(-1) !== "curl") return { ...parsed, error: "Only curl commands are accepted" };
  let url: string | undefined, rawBody: string | undefined, method: string | undefined;
  let optionError: string | undefined;
  const rawHeaders: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (["-d", "--data", "--data-raw", "--data-binary", "--json"].includes(token)) {
      if (rawBody !== undefined) optionError = "Multiple data arguments are not supported by the mock";
      rawBody = argv[++i];
      if (rawBody === undefined) optionError = `Missing value for ${token}`;
      if (token === "--json") rawHeaders.push("content-type: application/json");
    }
    else if (["-H", "--header"].includes(token)) {
      const value = argv[++i];
      if (value === undefined) optionError = `Missing value for ${token}`;
      rawHeaders.push(value ?? "");
    }
    else if (["-X", "--request"].includes(token)) {
      method = argv[++i];
      if (method === undefined) optionError = `Missing value for ${token}`;
    }
    else if (["-o", "--output", "--max-time", "--connect-timeout"].includes(token)) {
      const value = argv[++i];
      if (value === undefined) optionError = `Missing value for ${token}`;
      else if (["--max-time", "--connect-timeout"].includes(token) && !(Number.isFinite(Number(value)) && Number(value) >= 0)) {
        optionError = `Invalid duration for ${token}`;
      }
    }
    else if (/^https?:\/\//.test(token)) {
      if (url) optionError = "Multiple URLs are not supported by the mock";
      url = token;
    } else if (["--silent", "--show-error", "--fail", "--fail-with-body", "--insecure"].includes(token)
      || /^-[sSfk]+$/.test(token)) {
      // These flags do not change the HTTP method, destination, or request body.
    } else {
      optionError = `Unsupported curl option or argument: ${token}`;
    }
  }
  if (!url) return { ...parsed, error: "Missing URL" };
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); }
  catch { return { ...parsed, url, error: "Invalid URL" }; }
  const endpoint = parsedUrl.pathname;
  let family: ParsedCall["family"];
  let tool: string | undefined;
  if (endpoint.includes("/memory-bridge/")) {
    family = "memory";
    tool = ({
      "/atomic/search": "tdai_memory_search",
      "/atomic/query": "tdai_atomic_query",
      "/conversation/search": "tdai_conversation_search",
      "/conversation/query": "tdai_conversation_query",
      "/scenario/ls": "tdai_scenario_ls",
      "/scenario/read": "tdai_read_scene",
    } as Record<string, string>)[endpoint.slice(endpoint.indexOf("/v3") + 3)];
  } else if (endpoint.includes("/skill-bridge/")) {
    family = "skill";
    tool = ({
      "/search": "skill_search", "/get-by-name": "skill_view", "/files/read": "skill_files_read",
      "/extract": "skill_extract", "/create": "skill_create", "/update": "skill_update",
      "/patch": "skill_patch", "/delete": "skill_delete", "/files/write": "skill_files_write",
      "/files/remove": "skill_files_remove",
    } as Record<string, string>)[endpoint.slice(endpoint.indexOf("/skill", endpoint.indexOf("/v3")) + 6)];
  } else if (endpoint.endsWith("/tools/list") || endpoint.endsWith("/tools/call")) {
    family = "knowledge";
    tool = endpoint.endsWith("/tools/list") ? "tools/list" : undefined;
  }
  if (!new Set(["proxy.test", "knowledge.test"]).has(parsedUrl.hostname)) {
    return { ...parsed, url, endpoint, family, tool, error: "URL is outside the local mock allowlist" };
  }
  if (rawBody === undefined) return { ...parsed, url, endpoint, family, tool, error: "Missing JSON body" };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
    if (body === null || Array.isArray(body) || typeof body !== "object") throw new Error("object required");
  }
  catch { return { ...parsed, url, endpoint, family, tool, error: "Invalid JSON body" }; }
  if (family === "knowledge" && endpoint.endsWith("/tools/call")) {
    tool = typeof body.tool_name === "string" ? body.tool_name : undefined;
  }
  const headers = rawHeaders.map((header) => header.toLowerCase());
  const hasContentType = headers.some((header) => header.startsWith("content-type: application/json"));
  const hasService = headers.some((header) => /^x-tdai-service-id:\s*\S/.test(header));
  const hasConversation = headers.some((header) => /^x-conversation-id:\s*\S/.test(header));
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const requiredByTool: Record<string, string[]> = {
    tdai_memory_search: ["query"], tdai_conversation_search: ["query"],
    tdai_conversation_query: ["session_id"], tdai_read_scene: ["path"],
    skill_search: ["query"], skill_view: ["skill_name", "include_content", "include_manifest"],
    skill_files_read: ["skill_id", "path", "encoding"], skill_extract: [],
  };
  const required = tool ? requiredByTool[tool] ?? [] : [];
  const routeBodyValid = family === "knowledge"
    ? nonEmptyString(body.knowledge_id) && (endpoint.endsWith("/tools/list") || (
      nonEmptyString(body.tool_name) && isObject(body.params)
    ))
    : required.every((key) => ["include_content", "include_manifest"].includes(key)
      ? typeof body[key] === "boolean" : nonEmptyString(body[key]));
  const identityHeadersValid = family === "knowledge" ? hasService : hasService && hasConversation;
  const valid = Boolean(!optionError && family && tool && hasContentType && identityHeadersValid && routeBodyValid
    && (!method || method.toUpperCase() === "POST"));
  return {
    ...parsed, url, endpoint, family, tool, body,
    protocol_valid: valid,
    error: valid ? undefined : optionError ?? "Unknown route, invalid body, or missing required headers",
  };
}
