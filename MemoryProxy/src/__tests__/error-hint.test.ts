/**
 * 错误提示映射用例。
 */
import { describe, it, expect } from "vitest";
import { hintForStatus, friendlyProxyError } from "../common/error-hint.js";

describe("error-hint", () => {
  it("常用状态码有对应修复建议", () => {
    expect(hintForStatus(401)).toContain("API key");
    expect(hintForStatus(429)).toContain("稍后重试");
    expect(hintForStatus(503)).toContain("上游");
    expect(hintForStatus(500)).toContain("代理日志");
  });

  it("包装成带 code/hint 的错误体", () => {
    expect(friendlyProxyError(401, "bad token")).toEqual({
      code: "unauthorized",
      message: "bad token",
      hint: expect.stringContaining("API key") as unknown as string,
    });
    expect(friendlyProxyError(429, "slow down").code).toBe("rate_limited");
    expect(friendlyProxyError(503, "up").code).toBe("upstream_error");
  });
});
