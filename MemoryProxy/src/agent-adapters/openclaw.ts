/**
 * OpenClaw 客户端适配器。
 *
 * 调研依据（2026-08-27，见 MemoryProxy/docs/plugin-integration/
 * 2026-08-27-openclaw-dsh-ov-research.md）：
 *
 *   - OpenClaw（github.com/openclaw/openclaw）是开源 AI coding agent，
 *     分为 Gateway（多渠道接入）与内置 Agent runtime（src/agents + src/llm）
 *     两层。LLM 出站走 `models.providers.*` 自定义 provider 配置，
 *     `api: "openai-completions"`（未显式声明时也默认 openai-completions），
 *     即**标准 OpenAI Chat Completions**（POST /chat/completions + SSE），
 *     与 codebuddy / dsh 同族。
 *   - 官方文档明确支持 `models.providers.*.headers` 注入静态头
 *     （x-team-id / x-agent-id / x-task-id / x-conversation-id），因此
 *     Session Init 走 header 预选路径，无需表单。
 *   - OpenClaw 有自己的工具目录（coding profile 含 `ask_user` /
 *     `memory_search` / `memory_get` 等），与 proxy 的注入器体系互补：
 *     proxy 负责记忆注入，OpenClaw 原生工具负责交互与检索。
 *
 * 两个适配点：
 *   - `classifyRequest`: 恒 `"main"` —— OpenClaw 的 compaction / context
 *     pruning 由内置 hooks 驱动，同样走同一 provider 出站（无独立 header
 *     指纹），当前无可靠 aux 判据。保守走 main（等价 codebuddy），代价只是
 *     这些低频请求多一次注入，不破坏链路。
 *   - `extractUserText`: content 是 string 直接返回（OpenAI SDK 默认形态）；
 *     若未来版本改发 content-block 数组，走 default 兜底拼接。
 *
 * 风险与升级对策见调研文档「风险与对策」节。
 */

import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const openclawAdapter: AgentAdapter = {
  agentKind: "openclaw",

  classifyRequest(_body?, _path?, _headers?) {
    return "main";
  },

  extractUserText(content) {
    // OpenClaw 用 OpenAI SDK 发 chat completions，messages[].content 是字符串。
    // 留 default 兜底，避免上游改成 blocks 后取不到用户输入。
    if (typeof content !== "string") {
      return defaultAdapter.extractUserText(content);
    }
    return content.length > 0 ? content : null;
  },
};
