import * as resources from "@opentelemetry/resources";
import { describe, expect, it } from "vitest";

import { createOTelResource } from "./otel-resource.js";

describe("createOTelResource", () => {
  it("falls back to the legacy Resource constructor", () => {
    const attributes = { "service.name": "legacy-service" };
    let created: { attributes: Record<string, string> } | undefined;

    class LegacyResource {
      constructor(readonly attributes: Record<string, string>) {
        created = this;
      }
    }

    const result = createOTelResource(
      { Resource: LegacyResource } as never,
      attributes,
    );

    expect(result).toBe(created);
    expect(created?.attributes).toEqual(attributes);
  });

  it("rejects modules without a supported Resource API", () => {
    expect(() => createOTelResource({}, {})).toThrow(
      "@opentelemetry/resources exposes neither resourceFromAttributes() nor Resource",
    );
  });

  it("creates a resource with the installed OTel module", () => {
    const attributes = { "service.name": "installed-resource-test" };

    const resource = createOTelResource(resources, attributes);

    expect(resource.attributes).toMatchObject(attributes);
  });
});
