import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json" with { type: "json" };
import * as sdk from "./index.js";

describe("adapter SDK public entry", () => {
  it("declares a dedicated package export", () => {
    expect(packageJson.exports["./adapter-sdk"]).toEqual({
      types: "./src/adapters/sdk/index.ts",
      import: "./dist/adapter-sdk.mjs",
      default: "./dist/adapter-sdk.mjs",
    });
  });

  it("exports the stable runtime and operation store implementations", () => {
    expect(Object.keys(sdk).sort()).toEqual([
      "ExternalAdapterOperationStore",
      "FileAdapterOperationStore",
      "createAdapterRuntime",
      "createGatewayMemoryClient",
      "defaultAdapterOperationStateDir",
    ]);
  });
});