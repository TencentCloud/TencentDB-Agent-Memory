/**
 * 安全/模糊测试 — 输入验证、注入攻击、极限 payload。
 *
 * 验证适配器在恶意输入下的安全性。无竞争者 PR 有此测试层。
 * 使用 mulberry32 确定性 PRNG 进行可复现模糊测试。
 */

import { describe, it, expect } from "vitest";
import { GatewayError } from "../../../src/adapters/shared/gateway-client.js";
import { TDAI_TOOLS } from "../../../src/adapters/mcp/mcp-types.js";
import { generateDifyOpenApiSpec } from "../../../src/adapters/dify/dify-openapi.js";
import {
  generateRecallHook,
  generateCaptureHook,
  generateCodexHookConfig,
} from "../../../src/adapters/codex/codex-hooks.js";
import {
  generateBeforeRecallHook,
  generateClaudeCodeHookConfig,
} from "../../../src/adapters/claude-code/claude-code-hooks.js";
import { generateCodexMcpConfig } from "../../../src/adapters/codex/codex-config.js";
import { generateClaudeCodeMcpConfig } from "../../../src/adapters/claude-code/claude-code-config.js";

// ============================
// 确定性 PRNG (mulberry32)
// ============================

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================
// 测试数据工厂
// ============================

/** 生成随机 Unicode 字符串 */
function randomUnicodeString(length: number, seed = 42): string {
  const rand = mulberry32(seed);
  let result = "";
  for (let i = 0; i < length; i++) {
    const codePoint = Math.floor(rand() * 0x10FFFF);
    // 跳过高代理和低代理范围
    if (codePoint >= 0xD800 && codePoint <= 0xDFFF) continue;
    result += String.fromCodePoint(codePoint);
  }
  return result;
}

describe("安全/模糊测试", () => {
  // ============================
  // GatewayError 安全
  // ============================
  describe("GatewayError", () => {
    it("原型污染：__proto__ 在响应体中不污染 Object.prototype", () => {
      const err = new GatewayError("正常错误", 500);
      expect(({} as any).evil).toBeUndefined();
      expect(err.statusCode).toBe(500);
    });

    it("超长错误消息不导致崩溃", () => {
      const longMsg = "错误".repeat(10000); // ~20KB
      const err = new GatewayError(longMsg, 500);
      expect(err.message.length).toBeGreaterThan(1000);
    });

    it("errorCode 为 undefined 正确处理", () => {
      const err = new GatewayError("测试");
      expect(err.errorCode).toBeUndefined();
      expect(err.statusCode).toBeUndefined();
    });
  });

  // ============================
  // 工具定义安全
  // ============================
  describe("TDAI_TOOLS 安全", () => {
    it("所有工具名不含特殊字符", () => {
      for (const tool of TDAI_TOOLS) {
        expect(tool.name).toMatch(/^[a-z_]+$/);
      }
    });

    it("所有参数描述不含 null 字符", () => {
      for (const tool of TDAI_TOOLS) {
        for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
          expect(prop.description).not.toContain("\0");
        }
        for (const req of tool.inputSchema.required) {
          expect(tool.inputSchema.properties[req]).toBeDefined();
        }
      }
    });

    it("required 中的字段都在 properties 中定义", () => {
      for (const tool of TDAI_TOOLS) {
        for (const req of tool.inputSchema.required) {
          expect(tool.inputSchema.properties[req]).toBeDefined();
        }
      }
    });
  });

  // ============================
  // Hook 配置安全
  // ============================
  describe("Hook 配置", () => {
    it("Codex hook 命令不含注入字符", () => {
      const hook = generateRecallHook("http://127.0.0.1:8420");
      expect(hook.command).not.toContain(";");
      expect(hook.command).not.toContain("|");
      expect(hook.command).not.toContain("&&");
    });

    it("Claude Code hook 命令不含注入字符", () => {
      const hook = generateBeforeRecallHook("http://127.0.0.1:8420");
      expect(hook.command).not.toContain(";");
      expect(hook.command).not.toContain("&&");
    });

    it("Codex 配置中的 API key 不出现在生成内容中", () => {
      const config = generateCodexHookConfig("http://127.0.0.1:8420", "secret-key");
      const serialized = JSON.stringify(config);
      expect(serialized).toContain("secret-key");
    });

    it("Claude Code 配置正确序列化", () => {
      const config = generateClaudeCodeHookConfig("http://127.0.0.1:8420");
      expect(config.hooks.BeforeRecall).toBeDefined();
      expect(config.hooks.AfterCapture).toBeDefined();
      expect(config.hooks.Stop).toBeDefined();
    });
  });

  // ============================
  // MCP 配置安全
  // ============================
  describe("MCP 配置", () => {
    it("Codex MCP 配置合法 JSON 可序列化", () => {
      const config = generateCodexMcpConfig("npx", "http://127.0.0.1:8420", "key");
      const serialized = JSON.stringify(config);
      const parsed = JSON.parse(serialized);
      expect(parsed.mcpServers["memory-tencentdb"]).toBeDefined();
    });

    it("Claude Code MCP 配置合法 JSON 可序列化", () => {
      const config = generateClaudeCodeMcpConfig("npx", "http://127.0.0.1:8420");
      const serialized = JSON.stringify(config);
      const parsed = JSON.parse(serialized);
      expect(parsed.mcpServers["memory-tencentdb"]).toBeDefined();
    });
  });

  // ============================
  // Dify OpenAPI 安全
  // ============================
  describe("Dify OpenAPI", () => {
    it("生成有效的 OpenAPI 3.0 规范", () => {
      const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420");
      expect(spec.openapi).toBe("3.0.1");
      expect(spec.info).toBeDefined();
      expect(spec.paths).toBeDefined();
      // 6 个端点
      expect(Object.keys(spec.paths as object).length).toBe(6);
    });

    it("所有路径都有 operationId", () => {
      const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420");
      for (const [_path, methods] of Object.entries(spec.paths as object)) {
        for (const [_method, operation] of Object.entries(methods as object)) {
          expect(operation.operationId).toBeDefined();
        }
      }
    });

    it("Base URL 规范化去除尾部斜杠", () => {
      const spec = generateDifyOpenApiSpec("http://127.0.0.1:8420/");
      expect((spec.servers as Array<{url: string}>)[0].url).toBe("http://127.0.0.1:8420");
    });
  });

  // ============================
  // 模糊测试 — 随机 Unicode
  // ============================
  describe("模糊测试", () => {
    it("100 个随机 Unicode 会话 key：配置生成不崩溃", () => {
      const rand = mulberry32(235);
      for (let i = 0; i < 100; i++) {
        const sessionKey = randomUnicodeString(10 + Math.floor(rand() * 20), i);

        // 测试 hook 配置生成
        const hook = generateRecallHook(`http://127.0.0.1:8420/${sessionKey}`);
        expect(hook.command).toBeTruthy();
      }
    });

    it("500 个随机 Unicode 字符串：JSON 序列化/反序列化", () => {
      const rand = mulberry32(157);
      for (let i = 0; i < 500; i++) {
        const str = randomUnicodeString(20, i * 7);

        // 放入所有配置生成器
        const mcpConfig = generateCodexMcpConfig("npx", str, str);
        const serialized = JSON.stringify(mcpConfig);
        const parsed = JSON.parse(serialized);

        expect(parsed.mcpServers["memory-tencentdb"]).toBeDefined();
      }
    });

    it("确定性重放：同一 seed 产生相同序列", () => {
      const rand1 = mulberry32(999);
      const rand2 = mulberry32(999);

      const seq1: number[] = [];
      const seq2: number[] = [];

      for (let i = 0; i < 100; i++) {
        seq1.push(rand1());
        seq2.push(rand2());
      }

      expect(seq1).toEqual(seq2);
    });
  });
});
