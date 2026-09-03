import { describe, expect, it } from "vitest";
import { AGENT_KINDS } from "../../agent-adapters/types.js";
import { normalizeWhitelistRequestPath } from "../whitelist.js";

describe("AGENT_PREFIX_RE follows AGENT_KINDS", () => {
  it("strips /{kind} and /{kind}/{spaceId} for every AgentKind except unknown", () => {
    for (const kind of AGENT_KINDS) {
      if (kind === "unknown") continue;
      expect(normalizeWhitelistRequestPath(`/${kind}/team-abc/v1/messages`)).toBe(
        "/v1/messages",
      );
      expect(normalizeWhitelistRequestPath(`/${kind}/v1/messages`)).toBe("/v1/messages");
    }
  });
});
