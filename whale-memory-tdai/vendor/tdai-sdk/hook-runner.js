/**
 * Hook runner — the shared engine behind every platform hook script.
 *
 * Each runner implements the same flow:
 *   read stdin → adapter parses payload → Gateway call → adapter formats output
 *
 * Invariants (identical to the original Whale/Codex hooks):
 *   - NEVER throw, NEVER write to stdout on failure — a broken Gateway must
 *     never block a session start, a prompt, or a turn.
 *   - Only recall writes to stdout (the host injects it); health, capture and
 *     session-end are fire-and-forget.
 *
 * A concrete hook script is a two-liner:
 *   import { TdaiGatewayClient, runRecallHook } from "./vendor/tdai-sdk/index.js";
 *   await runRecallHook(adapter, new TdaiGatewayClient());
 */

/** Read stdin fully as UTF-8 (hook payloads arrive as one JSON document). */
export async function readStdin(stream = process.stdin) {
  let data = "";
  stream.setEncoding?.("utf-8");
  for await (const chunk of stream) data += chunk;
  return data;
}

/** Parse a hook payload; returns null (instead of throwing) on malformed JSON. */
function parsePayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the payload for a runner: explicit `opts.payload` (tests) or stdin.
 * @returns {Promise<any | null>}
 */
async function resolvePayload(opts) {
  if (opts.payload !== undefined) return opts.payload;
  return parsePayload(await readStdin(opts.stdin));
}

/**
 * The Gateway composes recall context for the in-process OpenClaw plugin,
 * whose tools are named tdai_memory_search / tdai_conversation_search. Thin
 * clients expose the same capabilities via the SDK MCP bridge under
 * search_memories / search_conversations — remap so the injected guide
 * doesn't point the model at tools that don't exist on this host.
 */
const RECALL_TOOL_NAME_MAP = [
  [/tdai_memory_search/g, "search_memories"],
  [/tdai_conversation_search/g, "search_conversations"],
];

function remapRecallToolNames(context) {
  let out = context;
  for (const [pattern, name] of RECALL_TOOL_NAME_MAP) out = out.replace(pattern, name);
  return out;
}

/**
 * SessionStart: verify the Gateway is reachable. Silent either way.
 *
 * @param {import("./gateway-client.js").TdaiGatewayClient} client
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>} true if the Gateway answered.
 */
export async function runHealthHook(client, opts = {}) {
  try {
    await client.health(opts.timeoutMs ?? 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * UserPromptSubmit: recall memory context and print it in the host's format.
 *
 * @param {import("./platform-adapter.js").BasePlatformAdapter} adapter
 * @param {import("./gateway-client.js").TdaiGatewayClient} client
 * @param {{ payload?: any, stdin?: NodeJS.ReadableStream, write?: (s: string) => void }} [opts]
 * @returns {Promise<string | null>} the emitted output line, or null when silent.
 */
export async function runRecallHook(adapter, client, opts = {}) {
  const write = opts.write ?? ((s) => process.stdout.write(s));
  try {
    const payload = await resolvePayload(opts);
    if (!payload) return null;

    const recall = adapter.parseRecallPayload(payload);
    if (!recall || !recall.query) return null;

    const res = await client.recall({
      query: recall.query,
      sessionKey: recall.sessionKey ?? "",
    });
    const context = typeof res?.context === "string" ? res.context : "";
    if (!context) return null;

    const out = adapter.formatRecallOutput(remapRecallToolNames(context), payload);
    if (!out) return null;
    write(out + "\n");
    return out;
  } catch {
    // Gateway unreachable/slow — stay silent, never block the prompt.
    return null;
  }
}

/**
 * Stop: capture the finished turn. Fire-and-forget; failures never surface.
 *
 * @param {import("./platform-adapter.js").BasePlatformAdapter} adapter
 * @param {import("./gateway-client.js").TdaiGatewayClient} client
 * @param {{ payload?: any, stdin?: NodeJS.ReadableStream }} [opts]
 * @returns {Promise<boolean>} true if the turn was sent to the Gateway.
 */
export async function runCaptureHook(adapter, client, opts = {}) {
  try {
    const payload = await resolvePayload(opts);
    if (!payload) return false;

    // May be async — e.g. Codex reads the transcript JSONL here.
    const turn = await adapter.parseCapturePayload(payload);
    if (!turn || (!turn.userContent && !turn.assistantContent)) return false;

    await client.capture({
      userContent: turn.userContent ?? "",
      assistantContent: turn.assistantContent ?? "",
      sessionKey: turn.sessionKey ?? "",
    });
    return true;
  } catch {
    // Fire-and-forget — capture failures must never surface to the user.
    return false;
  }
}

/**
 * SessionEnd: flush pending memory for the session (fills the /session/end
 * gap the raw Whale/Codex hooks left open). Silent either way.
 *
 * @param {import("./platform-adapter.js").BasePlatformAdapter} adapter
 * @param {import("./gateway-client.js").TdaiGatewayClient} client
 * @param {{ payload?: any, stdin?: NodeJS.ReadableStream }} [opts]
 * @returns {Promise<boolean>} true if the Gateway acknowledged the flush.
 */
export async function runSessionEndHook(adapter, client, opts = {}) {
  try {
    const payload = await resolvePayload(opts);
    if (!payload) return false;

    const sessionKey = adapter.sessionKeyFrom(payload);
    if (!sessionKey) return false;

    await client.endSession({ sessionKey });
    return true;
  } catch {
    // Session teardown must never error out of the host.
    return false;
  }
}
