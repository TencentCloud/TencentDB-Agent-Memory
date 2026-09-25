import { describe, expect, it } from "vitest";

import { parseCurl } from "../../scripts/eval/tool-routing/run.js";

describe("tool-routing runner curl parser", () => {
  it("accepts a documented memory request without executing it", () => {
    const parsed = parseCurl(
      "curl -sfk -X POST https://proxy.test/memory-bridge/v3/atomic/search "
      + "-H 'Content-Type: application/json' -H 'x-tdai-service-id: space-1' "
      + "-H 'x-conversation-id: session-1' -d '{\"query\":\"preference\",\"limit\":5}'",
    );
    expect(parsed).toMatchObject({
      protocol_valid: true,
      family: "memory",
      tool: "tdai_memory_search",
      endpoint: "/memory-bridge/v3/atomic/search",
    });
  });

  it("accepts a valid knowledge tools/call body", () => {
    const parsed = parseCurl(
      "curl -sSk -X POST https://knowledge.test/v3/tools/call "
      + "-H 'content-type: application/json' -H 'x-tdai-service-id: space-1' "
      + "-d '{\"knowledge_id\":\"kg-code\",\"tool_name\":\"search\",\"params\":{\"query\":\"SessionManager\"}}'",
    );
    expect(parsed).toMatchObject({ protocol_valid: true, family: "knowledge", tool: "search" });
  });

  it("rejects missing route fields and identity headers", () => {
    const parsed = parseCurl(
      "curl -sSk -X POST https://proxy.test/skill-bridge/v3/skill/get-by-name "
      + "-H 'content-type: application/json' -d '{\"skill_name\":\"pdf-workflow\"}'",
    );
    expect(parsed.protocol_valid).toBe(false);
  });

  it("rejects shell operators and command substitution", () => {
    expect(parseCurl("curl https://proxy.test/a; uname -a").protocol_valid).toBe(false);
    expect(parseCurl("curl https://proxy.test/a -d \"$(id)\"").protocol_valid).toBe(false);
  });

  it("rejects hosts outside the mock allowlist", () => {
    const parsed = parseCurl(
      "curl -X POST https://example.com/v3/tools/list -H 'content-type: application/json' "
      + "-H 'x-tdai-service-id: space-1' -d '{\"knowledge_id\":\"kg-code\"}'",
    );
    expect(parsed.protocol_valid).toBe(false);
    expect(parsed.error).toContain("allowlist");
  });
});
