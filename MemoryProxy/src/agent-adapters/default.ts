/**
 * Default agent adapter —— unknown/未识别客户端（cursor / windsurf / 用户自定义
 * SDK 等）的**保守兜底**实现，行为等价改造前的老逻辑：
 *   - classifyRequest: 恒返回 "main"（不启用分流）
 *   - extractUserText: 把 content 数组里所有 text block 拼接
 *
 * 未来新增客户端支持时，为它单独写一个 adapter（参考 claude-code.ts），
 * 在 index.ts 的 factory 里加分支即可。
 */

import type { AgentAdapter } from "./types.js";

/**
 * 把 content 数组里的所有 text block 拼接成字符串，等价现有 `contentToString`。
 * - string 输入 → 直接返回
 * - array 输入 → 收集每个 block 的 text，用 "\n" 拼接
 * - 其它 → null
 */
function joinAllTextBlocks(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export const defaultAdapter: AgentAdapter = {
  agentKind: "unknown",
  classifyRequest(_body?, _path?, _headers?) {
    return "main";
  },
  extractUserText(content) {
    return joinAllTextBlocks(content);
  },
};
