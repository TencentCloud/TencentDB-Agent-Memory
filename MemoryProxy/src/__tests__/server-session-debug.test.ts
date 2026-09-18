/**
 * /session-debug 路由级用例：admin 鉴权 + fenceCoverage / fenceMiss 输出。
 * 用临时 YAML + buildConfig 生成完整 ProxyConfig，避免手拼配置缺字段。
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { buildConfig } from "../config.js";
import { createApp } from "../server.js";
import {
  recordSession,
  resetSessionStats,
} from "../common/session-stats.js";

const tmpA = join(process.cwd(), ".session-debug-test-a.yaml");
const tmpB = join(process.cwd(), ".session-debug-test-b.yaml");

afterEach(() => {
  for (const f of [tmpA, tmpB]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  resetSessionStats();
});

describe("/session-debug 路由", () => {
  it("admin.apiKey 已配置但缺 Bearer → 401", async () => {
    writeFileSync(tmpA, 'admin:\n  apiKey: "sek"\n', "utf-8");
    const app = createApp(buildConfig({ configFile: tmpA }));
    const res = await app.request("/session-debug");
    expect(res.status).toBe(401);
  });

  it("正确 Bearer → 200 且输出 fenceMiss / fenceCoverage", async () => {
    writeFileSync(tmpA, 'admin:\n  apiKey: "sek"\n', "utf-8");
    resetSessionStats();
    recordSession("fenceBlocked", 2);
    recordSession("fenceAllowed", 8);
    recordSession("fenceMiss", 2);

    const app = createApp(buildConfig({ configFile: tmpA }));
    const res = await app.request("/session-debug", {
      headers: { authorization: "Bearer sek" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fenceCoverage: number;
      stats: { fenceMiss: number; fenceBlocked: number; fenceAllowed: number };
    };
    expect(body.fenceCoverage).toBe(0.833);
    expect(body.stats.fenceMiss).toBe(2);
    expect(body.stats.fenceBlocked).toBe(2);
    expect(body.stats.fenceAllowed).toBe(8);
  });

  it("admin.apiKey 为空 → 公开可访问（不 401）", async () => {
    writeFileSync(tmpB, 'admin:\n  apiKey: ""\n', "utf-8");
    const app = createApp(buildConfig({ configFile: tmpB }));
    const res = await app.request("/session-debug");
    expect(res.status).toBe(200);
  });
});
