import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type JsonSchemaObject = {
  properties?: Record<string, JsonSchemaObject>;
  enum?: unknown[];
  default?: unknown;
};

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: JsonSchemaObject };

function getOffloadProperties(): Record<string, JsonSchemaObject> {
  const offload = manifest.configSchema.properties?.offload;
  const properties = offload?.properties;

  expect(properties).toBeTruthy();
  return properties!;
}

describe("openclaw plugin manifest", () => {
  it("exposes every user-facing offload parser option", () => {
    const offloadProperties = getOffloadProperties();

    expect(Object.keys(offloadProperties)).toEqual(expect.arrayContaining([
      "enabled",
      "mode",
      "model",
      "temperature",
      "disableThinking",
      "forceTriggerThreshold",
      "dataDir",
      "defaultContextWindow",
      "maxPairsPerBatch",
      "l2NullThreshold",
      "l2TimeoutSeconds",
      "mildOffloadRatio",
      "aggressiveCompressRatio",
      "mmdMaxTokenRatio",
      "backendUrl",
      "backendApiKey",
      "backendTimeoutMs",
      "offloadRetentionDays",
      "logMaxSizeMb",
      "userId",
    ]));
  });

  it("does not default offload.mode in the manifest", () => {
    const offloadMode = getOffloadProperties().mode;

    expect(offloadMode.enum).toEqual(["local", "backend", "collect"]);
    expect(offloadMode).not.toHaveProperty("default");
  });
});
