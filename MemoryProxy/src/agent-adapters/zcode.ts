/**
 * ZCode (智谱 ZCode CLI/桌面端) client adapter.
 *
 * 抓包实证（2026-09-13，ZCode CLI 0.16.5 经 proxy 真机双协议各一条，DS 上游）：
 *   - anthropic kind: `POST /zcode/{spaceId}/v1/messages`（base 不带 /v1，客户端
 *     自拼）。user content 是 text block 数组，前面塞 `<system-reminder>`
 *     （skills 列表 / currentDate 等上下文），**最后一个 text block 才是用户
 *     键入**；cache_control 打在 system 全部块 + 最后一个 user block —— 与
 *     CC main 请求同构。
 *   - openai-compatible kind: `POST /zcode/{spaceId}/chat/completions`（无 /v1
 *     尾巴）。content 全是裸字符串（AI SDK 把 system-reminder 摊平成独立
 *     message），最后一条 user message 为用户键入；无 cache_control。此 kind
 *     需部署侧 `upstream.agents.zcode` 覆盖到 OpenAI 协议上游，否则 404。
 *   - 私有信号头：`x-zcode-agent` / `x-zcode-session-type`（唯一实测值 "main"）/
 *     `x-zcode-trace-id` / `x-zcode-app-version`；原生携带动态 `x-session-id`
 *     （每会话 UUID），与 `metadata.user_id` 内嵌 session_id 一致 —— 记忆链路
 *     的会话身份无需接入层注入。
 *   - tools 含原生 `AskUserQuestion`，session-init 表单（CC 状态机下发）理论
 *     可被应答；team/agent 预选仍推荐 provider headers 直配（CLI provider
 *     schema 原生支持 `headers` 字段）。
 *
 * 两个适配点：
 *   - `classifyRequest`: 恒 `"main"` —— 唯一实测取值就是 main，未捕获到
 *     fork/compact 类 aux 信号；发现 `x-zcode-session-type` 其他取值后再扩展。
 *   - `extractUserText`: `extractLastUserText` 双协议通吃 —— 字符串直返
 *     （openai 格式），数组取最后一个 text block（anthropic 格式，与 CC 同
 *     规则），恰好覆盖两种实测形态。
 */

import { extractLastUserText } from "../common/user-text-extractor.js";
import type { AgentAdapter } from "./types.js";

export const zcodeAdapter: AgentAdapter = {
  agentKind: "zcode",
  classifyRequest() {
    return "main";
  },
  extractUserText(content) {
    // 空字符串归一为 null（契约：null = 无用户键入文本），与 pi/dsh 一致。
    if (typeof content === "string") {
      return content.length > 0 ? content : null;
    }
    return extractLastUserText(content);
  },
};
