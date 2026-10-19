import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { extractApiKeyFromContext, type ApiKeyExtractionMode } from "../auth.js";

async function extract(headers: Record<string, string>, mode?: ApiKeyExtractionMode): Promise<string> {
  const app = new Hono();
  let out = "";
  app.post("/x", (c) => {
    out = extractApiKeyFromContext(c, mode);
    return c.text("ok");
  });
  await app.request("/x", { method: "POST", headers });
  return out;
}

const modes: ApiKeyExtractionMode[] = ["bearer-only", "bearer-first", "xapi-first"];

describe("extractApiKeyFromContext", () => {
  describe("without x-tdai-user-key (old behavior)", () => {
    it("bearer-first prefers Authorization", async () => {
      expect(await extract({ authorization: "Bearer a", "x-api-key": "b" }, "bearer-first")).toBe("a");
    });
    it("bearer-first falls back to x-api-key", async () => {
      expect(await extract({ "x-api-key": "b" }, "bearer-first")).toBe("b");
    });
    it("xapi-first prefers x-api-key", async () => {
      expect(await extract({ authorization: "Bearer a", "x-api-key": "b" }, "xapi-first")).toBe("b");
    });
    it("bearer-only ignores x-api-key", async () => {
      expect(await extract({ "x-api-key": "b" }, "bearer-only")).toBe("");
    });
    it("returns empty when nothing is sent", async () => {
      expect(await extract({})).toBe("");
    });
  });

  describe("with x-tdai-user-key", () => {
    for (const mode of modes) {
      it(`${mode}: the header is the user key and client credentials are ignored`, async () => {
        expect(await extract({
          "x-tdai-user-key": "sk-mem-1",
          authorization: "Bearer chatgpt-token",
          "x-api-key": "other",
        }, mode)).toBe("sk-mem-1");
      });
    }
    it("an empty header counts as absent", async () => {
      expect(await extract({ "x-tdai-user-key": "", authorization: "Bearer a" }, "bearer-first")).toBe("a");
    });
  });
});
