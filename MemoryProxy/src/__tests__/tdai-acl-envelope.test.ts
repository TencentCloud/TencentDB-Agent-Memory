import { afterEach, describe, expect, it, vi } from "vitest";

import { TdaiClient, checkAclOrDeny } from "../tdai/client.js";
import type { TdaiMemoryConfig } from "../tdai/types.js";

const config: TdaiMemoryConfig = {
  enabled: true,
  endpoint: "https://memory.example.test",
  apiKey: "service-token",
  serviceId: "instance-1",
  writeL0: true,
  recallL1: true,
  injectL2L3: true,
  l1Limit: 5,
  l2Limit: 5,
  timeoutMs: 5_000,
};

const params = {
  user_key: "sk-mem-user",
  asset_id: "asset-1",
  action: "read",
} as const;

function stubEnvelope(envelope: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TdaiClient ACL response envelopes", () => {
  it.each([
    { data: { allowed: true } },
    { code: "0", data: { allowed: true } },
    { code: null, data: { allowed: true } },
  ])("rejects a malformed business code: %#", async (envelope) => {
    stubEnvelope(envelope);

    await expect(new TdaiClient(config).checkAcl(params)).rejects.toThrow(
      "acl/check envelope code=",
    );
  });

  it("keeps the injection helper fail-closed for malformed envelopes", async () => {
    stubEnvelope({ data: { allowed: true } });

    await expect(
      checkAclOrDeny(new TdaiClient(config), params),
    ).resolves.toEqual({
      allowed: false,
      reason: "acl_check_error",
    });
  });

  it("preserves valid allow responses", async () => {
    stubEnvelope({ code: 0, data: { allowed: true, reason: "owner" } });

    await expect(new TdaiClient(config).checkAcl(params)).resolves.toEqual({
      allowed: true,
      reason: "owner",
    });
  });
});
