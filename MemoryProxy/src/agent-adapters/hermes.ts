/**
 * Hermes 客户端适配器。
 *
 * 调研依据（2026-08-27，hermes-agent 0.19.0 本机安装源码实证，见
 * MemoryProxy/docs/plugin-integration/2026-08-27-hermes-track03.md）：
 *
 *   - Hermes（github.com/NousResearch/hermes-agent，PyPI `hermes-agent`）是
 *     Nous Research 的开源 AI Agent 框架，CLI 名为 `hermes`，内置 70+ 工具
 *     （web_search / terminal / browser_* / delegate_task / clarify 等）。
 *   - LLM 出站走 OpenAI SDK。`model.provider: custom`（内置 CustomProfile，
 *     见 plugins/model-providers/custom/__init__.py）+ `model.base_url` 时
 *     api_mode 恒为 `chat_completions`（agent/agent_init.py:440-471 的
 *     provider 判定链），请求 POST `{base_url}/chat/completions`，即
 *     **标准 OpenAI Chat Completions**，与 codebuddy / dsh / openclaw 同族。
 *   - 自定义请求头有三个等价入口，均会把 header 合并到 OpenAI client 的
 *     default_headers（run_agent.py:4704-4718 +
 *     agent/auxiliary_client.py:590-620）：
 *       model.extra_headers / model.default_headers（别名，主客户端生效）
 *       providers.<name>.extra_headers
 *       custom_providers[].extra_headers
 *     因此 Session Init 走 header 预选路径，无需表单。
 *   - 交互式工具：`clarify`（tools/clarify_tool.py）是标准 OpenAI
 *     function-calling 工具，schema 为 `{name: "clarify", parameters:
 *     {question, choices}}`，由 Hermes 本地执行 CLI/平台交互、把用户回答
 *     作为 tool result 回填——对 Proxy 而言就是一次普通 tool-call 往返，
 *     无需协议特化，只需保证 SSE tool_calls 增量与 role=tool 消息不被破坏。
 *
 * 两个适配点：
 *   - `classifyRequest`: 恒 `"main"` —— Hermes 的 context compaction /
 *     title 等 aux 请求同样经 OpenAI SDK 走同一 base_url，目前未发现
 *     独立 header 或稳定 body 指纹（compression 走 auxiliary client 的
 *     独立 client 构造，无 dsh 那种 compact header）。保守走 main
 *     （等价 openclaw），代价只是这些低频请求多一次注入，不破坏链路。
 *     待抓包拿到真实 aux 请求后可在本文件补指纹。
 *   - `extractUserText`: content 是 string 直接返回（OpenAI SDK 默认形态）；
 *     若未来版本改发 content-block 数组，走 default 兜底拼接。
 *
 * 风险与升级对策见调研文档「风险与对策」节。
 */

import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const hermesAdapter: AgentAdapter = {
  agentKind: "hermes",

  classifyRequest(_body?, _path?, _headers?) {
    return "main";
  },

  extractUserText(content) {
    if (typeof content !== "string") {
      return defaultAdapter.extractUserText(content);
    }
    return content.length > 0 ? content : null;
  },
};
