/**
 * Type-level guard for `SessionIdFields.agent_source`.
 *
 * `memory-bridge.ts` passes `ids.agent_source` into
 * `emitBridgeRejectTelemetry({ agentSource: ... })` on the two reject paths
 * that run *after* identity resolution succeeded (non-object body, invalid
 * JSON body). The telemetry helper declares `agentSource?: string` as an
 * optional input and already falls back to `agentSourceFromSessionKey(sessionKey)`
 * when it is absent, so the field is legitimately optional on `SessionIdFields`
 * too — it simply was never declared, leaving both call sites with
 * TS2339 "Property 'agent_source' does not exist on type 'SessionIdFields'".
 *
 * Nothing produces the field today (`toIdFields` / `bindingToIdFields` do not
 * set it), which is exactly why the runtime never noticed: reading an
 * undeclared property is a compile-time error, not a runtime one. Declaring it
 * as optional keeps the existing producers valid and lets the reject paths
 * report the client family when it is available.
 *
 * The interface was also not exported, so no test outside the module could
 * reference it. It is exported here so this guard can bind to the real type
 * rather than a hand-written mirror (a mirror stays green even when the real
 * interface regresses).
 */

import { describe, expect, it } from "vitest";
import type { SessionIdFields } from "../memory-bridge.js";
import { agentSourceFromSessionKey } from "../bridge-telemetry.js";

describe("SessionIdFields.agent_source is declared and optional", () => {
  it("accepts the field when present", () => {
    const ids: SessionIdFields = {
      user_id: "u-1",
      team_id: "t-1",
      agent_id: "a-1",
      session_id: "s-1",
      agent_source: "codebuddy",
    };

    expect(ids.agent_source).toBe("codebuddy");
  });

  it("stays optional for producers that do not set it", () => {
    const ids: SessionIdFields = {
      user_id: "u-1",
      team_id: "t-1",
      agent_id: "a-1",
      session_id: "s-1",
      composite_key: "claude-code:conv-abc",
    };

    expect(ids.agent_source).toBeUndefined();
  });

  it("matches the telemetry fallback, so an absent field is not a gap", () => {
    // What emitBridgeRejectTelemetry does when agentSource is not supplied.
    expect(agentSourceFromSessionKey("claude-code:conv-abc")).toBe("claude-code");
    expect(agentSourceFromSessionKey("codebuddy:conv-abc")).toBe("codebuddy");
    expect(agentSourceFromSessionKey("conv-abc")).toBe("unknown");
  });
});
