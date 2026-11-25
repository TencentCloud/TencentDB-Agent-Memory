import type http from "node:http";
import { describe, expect, it } from "vitest";
import {
  getSkillAssetInstance,
  resolveSkillAssetInstance,
  runWithSkillAssetInstance,
} from "../core/skill/skill-asset-context.js";
import {
  handleV2Route,
  successEnvelope,
  type V2RouterDeps,
} from "./v2-router.js";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("skill asset request instance", () => {
  it("keeps concurrent request instances isolated", async () => {
    const results = await Promise.all([
      runWithSkillAssetInstance("lab-01", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getSkillAssetInstance();
      }),
      runWithSkillAssetInstance("lab-02", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getSkillAssetInstance();
      }),
    ]);

    expect(results).toEqual(["lab-01", "lab-02"]);
    expect(getSkillAssetInstance()).toBeUndefined();
    expect(resolveSkillAssetInstance("default")).toBe("default");
    await runWithSkillAssetInstance("lab-03", async () => {
      expect(resolveSkillAssetInstance("default")).toBe("lab-03");
    });
  });

  it("propagates auth.serviceId through the real extra-route dispatch path", async () => {
    const pathname = "/v3/skill/context-probe";
    let observedInstance: string | undefined;

    const handled = await handleV2Route(
      {
        headers: {
          authorization: "Bearer test-key",
          "x-tdai-service-id": "lab-01",
        },
        url: pathname,
      } as unknown as http.IncomingMessage,
      {} as http.ServerResponse,
      pathname,
      "POST",
      async () => ({}),
      () => {},
      {
        getStore: () => undefined,
        getEmbedding: () => undefined,
        getStorage: () => undefined,
        logger,
      } as unknown as V2RouterDeps,
      {
        [pathname]: async (_body, auth) => {
          observedInstance = getSkillAssetInstance();
          return successEnvelope({ service_id: auth.serviceId }, "test-request");
        },
      },
    );

    expect(handled).toBe(true);
    expect(observedInstance).toBe("lab-01");
  });
});
