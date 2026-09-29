import { describe, expect, it } from "vitest";

import { TdaiGateway } from "./server.js";

describe("TdaiGateway skill asset lifecycle", () => {
  it("does not bind the shared standalone SkillCore to the default metadata instance", () => {
    const gateway = new TdaiGateway({
      data: { baseDir: "/tmp/tdai-gateway-skill-asset-instance-test" },
    });

    // The shared core serves requests with different x-tdai-service-id values.
    // Asset registration must therefore stay in the request handler, where the
    // authenticated service id is available.
    const core = (gateway as unknown as {
      core: { skillAssetHooks?: unknown };
    }).core;

    expect(core.skillAssetHooks).toBeUndefined();
  });
});
