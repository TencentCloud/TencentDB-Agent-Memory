/**
 * Hermes 客户端适配器。
 *
 * hermes（github.com/NousResearch/hermes-agent，PyPI `hermes-agent`）是
 * Nous Research 的开源 AI Agent 框架，CLI 名为 `hermes`，内置 70+ 工具
 * （web_search / terminal / browser_* / delegate_task / clarify 等）。
 * 调研依据：hermes-agent 0.19.x 源码 + #1196 TRACK 03 调研结论。
 *
 *   - LLM 出站走 OpenAI SDK。`model.provider: custom` + `model.base_url` 时
 *     api_mode 恒为 `chat_completions`（agent/agent_init.py 的 provider 判定链），
 *     请求 POST `{base_url}/chat/completions`，即**标准 OpenAI Chat
 *     Completions**，与 codebuddy / dsh / openclaw 同族。
 *   - 交互式工具：`clarify`（tools/clarify_tool.py）是标准 OpenAI
 *     function-calling 工具，由 Hermes 本地执行 CLI/平台交互、把用户回答
 *     作为 tool result 回填——对 Proxy 而言就是一次普通 tool-call 往返，
 *     无需协议特化，只需保证 SSE tool_calls 增量与 role=tool 消息不被破坏。
 *
 * 两个适配点：
 *   - `classifyRequest`: 恒 `"main"` —— Hermes 的 context compaction /
 *     title 等 aux 请求同样经 OpenAI SDK 走同一 base_url，目前未发现
 *     独立 header 或稳定 body 指纹（compression 走 auxiliary client 的
 *     独立 client 构造，无 dsh 那种 compact header）。保守走 main
 *     （等价 openclaw / pi），代价只是这些低频请求多一次注入，不破坏链路。
 *     待抓包拿到真实 aux 请求后可在本文件补指纹。
 *   - `extractUserText`: content 是 string 直接返回（OpenAI SDK 默认形态）；
 *     若未来版本改发 content-block 数组，走 default 兜底拼接。
 */
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const hermesAdapter: AgentAdapter = {
  agentKind: "hermes",
  classifyRequest() {
    return "main";
  },
  extractUserText(content) {
    if (typeof content === "string") return content.length > 0 ? content : null;
    return defaultAdapter.extractUserText(content);
  },
};
