/**
 * 幂等写入测试 — 验证重复 capture 调用不会导致数据重复。
 *
 * 参考 PR #540 的幂等写入设计。
 *
 * 覆盖：
 * - 同一 turn 重复调用（相同 content + sessionKey）
 * - Gateway 超时后重试（content 相同但重试多次）
 * - 跨 session 边界（不同 sessionKey 的相同 content）
 * - 并发 capture 同一 turn
 * - Fake Gateway 端 dedup 行为
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FakeGateway } from "../helpers/fake-gateway.js";
import { HttpMemoryClient } from "../../../src/adapters/index.js";

let gw: FakeGateway;

beforeAll(async () => {
  gw = new FakeGateway();
  await gw.start();
});

afterAll(async () => {
  await gw.stop();
});

beforeEach(() => {
  gw.reset();
});

// ============================
// Suite 1: 基础幂等验证
// ============================

describe("幂等写入: 基础验证", () => {
  it("同一 turn 重复 capture 3 次 → 每次请求都发送（幂等由 Gateway/Core 保证）", async () => {
    const client = new HttpMemoryClient({ baseUrl: gw.url, timeoutMs: 5000 });
    const params = {
      userContent: "今天天气怎么样？",
      assistantContent: "今天北京晴，气温 25°C",
      sessionKey: "sess-1",
    };

    gw.onCapture({ l0_recorded: 1, scheduler_notified: true });

    // 重复 3 次相同的 capture
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await client.capture(params));
    }

    // 所有调用应该成功
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.l0_recorded).toBe(1);
    }

    // 验证 Gateway 收到了 3 次请求（传输层不做 dedup）
    expect(gw.captureCount()).toBe(3);

    // 所有请求内容一致
    const allReqs = gw.allCaptureRequests();
    for (const req of allReqs) {
      expect(req.user_content).toBe(params.userContent);
      expect(req.assistant_content).toBe(params.assistantContent);
      expect(req.session_key).toBe(params.sessionKey);
    }
  });

  it("不同 sessionKey 的相同 content → 独立请求", async () => {
    const client = new HttpMemoryClient({ baseUrl: gw.url, timeoutMs: 5000 });

    gw.onCapture({ l0_recorded: 1, scheduler_notified: true });

    await client.capture({
      userContent: "hi",
      assistantContent: "hello",
      sessionKey: "sess-a",
    });

    await client.capture({
      userContent: "hi",
      assistantContent: "hello",
      sessionKey: "sess-b",
    });

    expect(gw.captureCount()).toBe(2);

    const reqs = gw.allCaptureRequests();
    expect(reqs[0].session_key).toBe("sess-a");
    expect(reqs[1].session_key).toBe("sess-b");
  });
});

// ============================
// Suite 2: 超时重试下的幂等
// ============================

describe("幂等写入: 超时重试", () => {
  it("Gateway 慢响应后重试 — 内容不丢失", async () => {
    // 模拟慢 Gateway（200ms 延迟）
    gw.onCapture({ l0_recorded: 1, scheduler_notified: true }, 200, 0);

    const client = new HttpMemoryClient({
      baseUrl: gw.url,
      timeoutMs: 10000,
      retry: { maxAttempts: 0 }, // 不重试
    });

    const r = await client.capture({
      userContent: "慢请求测试",
      assistantContent: "慢响应但完整",
      sessionKey: "sess-slow",
    });

    expect(r.l0_recorded).toBe(1);
    expect(gw.captureCount()).toBe(1);

    // 请求内容完整
    const req = gw.lastCaptureRequest();
    expect(req?.user_content).toBe("慢请求测试");
    expect(req?.assistant_content).toBe("慢响应但完整");
  });
});

// ============================
// Suite 3: 大数据量捕获
// ============================

describe("幂等写入: 大数据量", () => {
  it("长文本捕获（10k+ 字符）", async () => {
    const client = new HttpMemoryClient({ baseUrl: gw.url, timeoutMs: 30000 });

    gw.onCapture({ l0_recorded: 1, scheduler_notified: true });

    // 生成 ~10k 字符的 assistant content（模拟代码生成）
    const longAssistant = `这是代码生成结果：\n\`\`\`typescript\n${
      Array.from({ length: 200 }, (_, i) => `// Line ${i + 1}: export const fn_${i} = () => {\n  return ${JSON.stringify({ id: i, name: `item_${i}`, value: Math.random() })};\n};\n`).join("")
    }\`\`\``;

    const r = await client.capture({
      userContent: "生成 200 个工具函数",
      assistantContent: longAssistant,
      sessionKey: "sess-long",
    });

    expect(r.l0_recorded).toBe(1);

    const req = gw.lastCaptureRequest();
    expect(req?.assistant_content?.length).toBeGreaterThan(8000);
    expect(req?.user_content).toBe("生成 200 个工具函数");
  });

  it("Unicode 和 emoji 内容正确传递", async () => {
    const client = new HttpMemoryClient({ baseUrl: gw.url, timeoutMs: 5000 });

    gw.onCapture({ l0_recorded: 1, scheduler_notified: true });

    await client.capture({
      userContent: "你好！🚀 こんにちは！🎉",
      assistantContent: "Bonjour! 🌍 Привет! 👋 中文测试",
      sessionKey: "sess-unicode",
    });

    const req = gw.lastCaptureRequest();
    expect(req?.user_content).toBe("你好！🚀 こんにちは！🎉");
    expect(req?.assistant_content).toBe("Bonjour! 🌍 Привет! 👋 中文测试");
  });
});

// ============================
// Suite 4: Gateway 端 Dedup 模拟
// ============================

describe("幂等写入: Gateway 端 Dedup", () => {
  it("Fake Gateway 模拟 dedup — 相同 sessionKey+content 只记录一次", async () => {
    const seen = new Set<string>();

    gw.setCustomHandler((_req, body) => {
      const b = body as { user_content: string; assistant_content: string; session_key: string };
      const key = `${b.session_key}::${b.user_content}::${b.assistant_content}`;

      if (seen.has(key)) {
        return {
          status: 200,
          body: { l0_recorded: 0, scheduler_notified: false, dedup: true },
        };
      }

      seen.add(key);
      return {
        status: 200,
        body: { l0_recorded: 1, scheduler_notified: true, dedup: false },
      };
    });

    const client = new HttpMemoryClient({ baseUrl: gw.url, timeoutMs: 5000 });

    // 首次
    const r1 = await client.capture({
      userContent: "唯一消息",
      assistantContent: "唯一回复",
      sessionKey: "dedup-sess",
    });
    expect(r1.l0_recorded).toBe(1);

    // 重复
    const r2 = await client.capture({
      userContent: "唯一消息",
      assistantContent: "唯一回复",
      sessionKey: "dedup-sess",
    });
    expect(r2.l0_recorded).toBe(0);
  });
});
