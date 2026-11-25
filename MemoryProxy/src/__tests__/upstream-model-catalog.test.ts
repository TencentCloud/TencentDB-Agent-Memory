import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildConfig } from "../config.js";
import { buildModelsResponse } from "../modelsHandler.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("configured upstream model discovery", () => {
  it("publishes an upstream model even when the credit pricing table is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-models-"));
    tempDirs.push(dir);
    const configFile = join(dir, "config.yaml");
    await writeFile(configFile, [
      "upstream:",
      "  url: https://llm.example.com/v1",
      "  apiKey: upstream-secret",
      "  models:",
      "    - deepseek-chat",
      "creditPricing:",
      "  models: []",
      "",
    ].join("\n"), "utf8");

    const config = buildConfig({ configFile });
    expect(config.upstream.models).toEqual(["deepseek-chat"]);

    const response = buildModelsResponse(config.creditPricing, config.upstream.models ?? []);
    expect(response.data.map((model) => model.id)).toEqual(["deepseek-chat"]);
  });

  it("accepts a scalar model ID and ignores non-string entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-models-"));
    tempDirs.push(dir);
    const scalarFile = join(dir, "scalar.yaml");
    await writeFile(scalarFile, [
      "upstream:",
      "  url: https://llm.example.com/v1",
      "  models: deepseek-chat",
      "",
    ].join("\n"), "utf8");
    const mixedFile = join(dir, "mixed.yaml");
    await writeFile(mixedFile, [
      "upstream:",
      "  url: https://llm.example.com/v1",
      "  models:",
      "    - deepseek-chat",
      "    - 123",
      "",
    ].join("\n"), "utf8");

    expect(buildConfig({ configFile: scalarFile }).upstream.models).toEqual(["deepseek-chat"]);
    expect(buildConfig({ configFile: mixedFile }).upstream.models).toEqual(["deepseek-chat"]);
  });
});
