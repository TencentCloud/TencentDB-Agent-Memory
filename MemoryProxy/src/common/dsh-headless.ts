/**
 * dsh headless / no-preset bypass.
 *
 * Historical rule: a non-empty `body.tools` list that does not advertise
 * `ask_user_question` is CLI headless (or an API caller with custom tools).
 * Proxy must not inject a fake `ask_user_question` tool_call — the client
 * rejects unknown tools — and must skip session-init, mem forms, injection,
 * L0, and skill extraction.
 *
 * That rule mis-classifies PTC (`mode: ptc`). PTC puts only the reserved
 * `run_code` transport on the wire; every other tool, including
 * `ask_user_question`, is declared in the system prompt and called from
 * inside the program. Those sessions are interactive and must keep
 * session-init and memory injection.
 *
 * Empty tools stay off this bypass (plain chat / title-gen aux). A list
 * that still names any tool other than `run_code`, and does not name
 * `ask_user_question`, stays headless.
 */

function readTools(body: unknown): unknown[] | null {
  if (!body || typeof body !== "object") return null;
  const tools = (body as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools : null;
}

/**
 * OpenAI `{function:{name}}` wins over a flat `{name}` when both are set.
 * An explicit empty `function.name` does not fall through (`??` semantics):
 * the historical inline check used `function.name ?? name`.
 */
function toolName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== "object") return undefined;
  const fn = (tool as { function?: { name?: unknown } }).function;
  const nested = fn && typeof fn === "object" ? fn.name : undefined;
  const flat = (tool as { name?: unknown }).name;
  const name = (typeof nested === "string" ? nested : undefined)
    ?? (typeof flat === "string" ? flat : undefined);
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function namedTools(tools: unknown[]): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    const name = toolName(tool);
    if (name) names.push(name);
  }
  return names;
}

/** PTC wire shape: every named tool is the reserved `run_code` transport. */
function isRunCodeOnly(tools: unknown[]): boolean {
  const names = namedTools(tools);
  return names.length > 0 && names.every((name) => name === "run_code");
}

/**
 * True when this dsh request is the PTC wire shape: the only named tool is
 * the reserved `run_code` transport.
 */
export function isDshPtcPresentation(agentSource: string, body: unknown): boolean {
  if (agentSource !== "dsh") return false;
  const tools = readTools(body);
  if (!tools || tools.length === 0) return false;
  return isRunCodeOnly(tools);
}

/**
 * True when this dsh request is CLI headless / no-preset and must bypass
 * session-init and memory side effects.
 *
 * PTC (`run_code` only) returns false so interactive sessions still run
 * session-init and memory injection.
 */
export function isDshHeadlessNoPreset(agentSource: string, body: unknown): boolean {
  if (agentSource !== "dsh") return false;
  const tools = readTools(body);
  if (!tools || tools.length === 0) return false;
  if (tools.some((tool) => toolName(tool) === "ask_user_question")) return false;
  if (isRunCodeOnly(tools)) return false;
  return true;
}
