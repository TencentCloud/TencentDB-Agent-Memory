/**
 * Claude Code CLI 客户端适配器。
 *
 * 特化实现：
 *   - classifyRequest: cache_control marker 位置 + tools/thinking 三分
 *     (来源: 逆向 CC 源码 forkedAgent.ts / sideQuery.ts + 抓包实证)
 *   - extractUserText: 取最后一个 text block
 *     (CC user content 常前面塞多段 <system-reminder> 元数据，最后一段才是用户输入)
 *
 * 详见 docs/design/2026-07-30-cc-request-routing-plan.md
 */

import { classifyCcRequest } from "../common/cc-request-classifier.js";
import { extractLastUserText } from "../common/user-text-extractor.js";
import type { AgentAdapter } from "./types.js";

export const claudeCodeAdapter: AgentAdapter = {
  agentKind: "claude-code",
  classifyRequest(body, _path?, _headers?) {
    return classifyCcRequest(body);
  },
  extractUserText(content) {
    return extractLastUserText(content);
  },
};
