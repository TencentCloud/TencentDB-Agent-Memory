/**
 * Platform adapter — the standard interface a new platform must implement to
 * onboard onto TDAI memory, plus a `BasePlatformAdapter` that supplies safe
 * defaults for everything except the three points that actually differ between
 * hosts:
 *
 *   1. how to extract the recall query from a hook payload   (parseRecallPayload)
 *   2. how to extract the finished turn for capture          (parseCapturePayload)
 *   3. how to format recalled context for the host to inject (formatRecallOutput)
 *
 * Everything else (HTTP calls, timeouts, silent failure, MCP tools, auth,
 * session/end) is handled by the shared SDK. A concrete adapter is therefore
 * tiny — see whale-memory-tdai/adapter.js and codex-memory-tdai/adapter.js.
 *
 * A "descriptor" is the minimal object a platform provides; `BasePlatformAdapter`
 * turns it into a full adapter. Platforms may also subclass directly.
 */

/**
 * @typedef {Object} RecallInput
 * @property {string} query        The user prompt / recall query.
 * @property {string} [sessionKey] Session identifier.
 *
 * @typedef {Object} CaptureInput
 * @property {string} userContent
 * @property {string} assistantContent
 * @property {string} [sessionKey]
 *
 * @typedef {Object} PlatformDescriptor
 * @property {string} name
 * @property {(payload: any) => (RecallInput | null)} [parseRecallPayload]
 * @property {(payload: any) => (CaptureInput | null | Promise<CaptureInput | null>)} [parseCapturePayload]
 * @property {(context: string, payload: any) => string} [formatRecallOutput]
 * @property {(payload: any) => string} [sessionKeyFrom]
 */

export class BasePlatformAdapter {
  /**
   * @param {PlatformDescriptor} [descriptor]
   */
  constructor(descriptor = {}) {
    this.name = descriptor.name ?? "unknown";
    this._descriptor = descriptor;
  }

  /**
   * Extract the recall query + session from a UserPromptSubmit payload.
   * Default: reads `prompt` and `session_id` (the shape Whale/Codex hosts use).
   *
   * @param {any} payload
   * @returns {RecallInput | null}
   */
  parseRecallPayload(payload) {
    if (this._descriptor.parseRecallPayload) {
      return this._descriptor.parseRecallPayload(payload);
    }
    const query = typeof payload?.prompt === "string" ? payload.prompt : "";
    if (!query) return null;
    return { query, sessionKey: this.sessionKeyFrom(payload) };
  }

  /**
   * Extract the finished turn from a Stop payload. May be async (e.g. a host
   * that only provides a transcript file path must read it here).
   * Default: reads `prompt` + `last_assistant_text` (the Whale shape).
   *
   * @param {any} payload
   * @returns {CaptureInput | null | Promise<CaptureInput | null>}
   */
  parseCapturePayload(payload) {
    if (this._descriptor.parseCapturePayload) {
      return this._descriptor.parseCapturePayload(payload);
    }
    const userContent = typeof payload?.prompt === "string" ? payload.prompt : "";
    const assistantContent =
      typeof payload?.last_assistant_text === "string" ? payload.last_assistant_text : "";
    if (!userContent && !assistantContent) return null;
    return { userContent, assistantContent, sessionKey: this.sessionKeyFrom(payload) };
  }

  /**
   * Format recalled context into the JSON string the host expects on stdout.
   * Default: Whale-style `{ decision: "pass", additional_context }`.
   *
   * @param {string} context
   * @param {any} payload
   * @returns {string}
   */
  formatRecallOutput(context, payload) {
    if (this._descriptor.formatRecallOutput) {
      return this._descriptor.formatRecallOutput(context, payload);
    }
    return JSON.stringify({
      decision: "pass",
      additional_context: `## Memory Context\n${context}`,
    });
  }

  /**
   * Extract a session key from a payload. Default: `session_id`.
   * @param {any} payload
   * @returns {string}
   */
  sessionKeyFrom(payload) {
    if (this._descriptor.sessionKeyFrom) {
      return this._descriptor.sessionKeyFrom(payload);
    }
    return typeof payload?.session_id === "string" ? payload.session_id : "";
  }
}

/**
 * Convenience factory: build an adapter from a plain descriptor object.
 * @param {PlatformDescriptor} descriptor
 * @returns {BasePlatformAdapter}
 */
export function defineAdapter(descriptor) {
  return new BasePlatformAdapter(descriptor);
}
