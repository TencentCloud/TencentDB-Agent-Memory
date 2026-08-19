/**
 * pi 客户端适配器。
 *
 * pi（https://github.com/earendil-works/pi-mono）是一个 coding agent，走标准
 * OpenAI Chat Completions 协议（`/pi/{spaceId}/v1/chat/completions`）。
 *
 * 与 CodeBuddy 不同，pi 的 message.content 是标准 OpenAI 形态（字符串或
 * content-block 数组，无 CB 的 pseudo-XML wrapper），没有 cache_control /
 * fork / sidequery 分流特征。因此两个适配点都复用 default 的保守行为：
 *   - `classifyRequest`: 恒 `"main"`（走完整 injection + L0 + skill 链路）
 *   - `extractUserText`: 字符串直接返回，数组则拼接所有 text block
 */

import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const piAdapter: AgentAdapter = {
  ...defaultAdapter,
  agentKind: "pi",
};
