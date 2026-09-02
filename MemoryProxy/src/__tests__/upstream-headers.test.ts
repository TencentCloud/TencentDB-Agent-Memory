/**
 * 上游转发头处理（去重后的唯一实现）用例。
 */
import { describe, it, expect } from "vitest";
import {
  collectRequestHeaders,
  filterResponseHeaders,
  SKIP_REQUEST_HEADERS,
  SKIP_RESPONSE_HEADERS,
} from "../upstream/headers.js";

describe("upstream/headers", () => {
  it("collectRequestHeaders 跳过传输层头与内部身份头，保留其它", () => {
    const ctx = {
      req: {
        raw: {
          headers: new Headers({
            host: "proxy.local",
            "content-length": "100",
            "x-tdai-user-key": "internal",
            authorization: "Bearer token",
            "content-type": "application/json",
          }),
        },
      },
    } as never;
    const out = collectRequestHeaders(ctx);
    expect(out).not.toHaveProperty("host");
    expect(out).not.toHaveProperty("content-length");
    expect(out).not.toHaveProperty("x-tdai-user-key");
    expect(out.authorization).toBe("Bearer token");
    expect(out["content-type"]).toBe("application/json");
  });

  it("filterResponseHeaders 去掉传输层头，保留业务头", () => {
    const src = new Headers({
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      connection: "keep-alive",
      "x-custom": "yes",
    });
    const out = filterResponseHeaders(src);
    expect(out.get("content-type")).toBe("text/event-stream");
    expect(out.get("x-custom")).toBe("yes");
    expect(out.has("content-encoding")).toBe(false);
    expect(out.has("connection")).toBe(false);
  });

  it("跳过集合包含预期头", () => {
    expect(SKIP_REQUEST_HEADERS.has("x-tdai-user-key")).toBe(true);
    expect(SKIP_REQUEST_HEADERS.has("host")).toBe(true);
    expect(SKIP_RESPONSE_HEADERS.has("content-length")).toBe(true);
  });
});
