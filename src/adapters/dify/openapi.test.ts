/**
 * OpenAPI spec generator tests (offline).
 */

import { describe, expect, it } from "vitest";

import { buildOpenApiSpec } from "./openapi.js";

describe("buildOpenApiSpec", () => {
  const spec = buildOpenApiSpec("http://127.0.0.1:8421") as {
    openapi: string;
    servers: Array<{ url: string }>;
    paths: Record<string, { post?: { operationId: string; requestBody: unknown } }>;
    components: { securitySchemes: Record<string, { type: string; scheme: string }> };
    security: unknown[];
  };

  it("emits an OpenAPI 3.1 document pointing at the given server", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers).toEqual([{ url: "http://127.0.0.1:8421" }]);
  });

  it("describes exactly the two tool operations with stable operationIds", () => {
    expect(Object.keys(spec.paths).sort()).toEqual(["/tools/capture", "/tools/recall"]);
    expect(spec.paths["/tools/capture"].post?.operationId).toBe("memory_capture");
    expect(spec.paths["/tools/recall"].post?.operationId).toBe("memory_recall");
  });

  it("declares bearer auth as the global security scheme", () => {
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
  });

  it("marks the write-path required fields in the capture schema", () => {
    const captureSchema = (
      spec.paths["/tools/capture"].post as unknown as {
        requestBody: { content: { "application/json": { schema: { required: string[] } } } };
      }
    ).requestBody.content["application/json"].schema;
    expect(captureSchema.required).toEqual(["user_content", "assistant_content"]);
  });

  it("round-trips through JSON cleanly (importable by Dify)", () => {
    expect(() => JSON.parse(JSON.stringify(spec))).not.toThrow();
  });
});
