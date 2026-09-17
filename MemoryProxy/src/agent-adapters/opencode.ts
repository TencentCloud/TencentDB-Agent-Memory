/**
 * opencode 客户端适配器。
 *
 * 背景（2026-08-19 官方文档 https://opencode.ai/docs/providers/）：
 *
 *   - 开源终端 AI 编程 Agent（sst/opencode），支持 75+ provider
 *   - 用户在 `opencode.json` 里自选 provider，绝大多数场景通过 AI SDK
 *     `@ai-sdk/openai-compatible` 打到自定义 baseURL，即 **标准 OpenAI
 *     Chat Completions**（`POST /v1/chat/completions`）
 *   - 少数模型走 `@ai-sdk/openai` 的 Responses API；覆盖 anthropic baseURL
 *     的场景走 `/v1/messages`。本 adapter **只覆盖主流 chat/completions 场景**
 *   - 与 codebuddy / dsh 同族协议
 *
 * # 与已有 openai-chat 客户端的差异
 *
 *   - CodeBuddy: content 恒字符串，塞 `<user_query>` / `<additional_data>`
 *     / `<user_info>` wrapper —— 需走 `extractUserQueryText` 剥离
 *   - dsh: content 恒字符串，**裸文本**无 wrapper —— 直接返回
 *   - opencode: 抓包尚未实证。**从项目定位（通用 CLI）推断更接近 dsh**：
 *     不会塞私有 wrapper，用户输入应为裸文本
 *
 *   保守策略：走 `extractUserQueryText`。
 *   —— 该函数对"无 wrapper 的纯字符串"会原样返回，对未来 opencode 若真
 *      塞了 wrapper 也能吃下（forward-compatible）；两种形态零回归。
 *
 * # 两个适配点
 *   - `classifyRequest`: 恒 `"main"`（opencode 是通用 CLI，没有 fork/aux 语义）
 *   - `extractUserText`: 字符串 → extractUserQueryText 剥离；数组 → default 兜底
 *
 * # 与 codebuddy adapter 的关系
 *
 *   实现几乎一致（同协议 + 同兜底策略）。故意保留独立文件而非 alias/复用
 *   codebuddyAdapter，理由：
 *   1. 未来 opencode 若发现私有信号（aux endpoint、专属 header）需要独立演进
 *   2. 语义所属清晰：agentKind === "opencode" 便于 telemetry 归因
 *
 * TODO(抓包实证)：待用户在生产环境跑起 opencode 后，抓一条真实请求，
 *   核对：
 *     (a) content 是否裸文本（无 wrapper）→ 若是，可切换到 dsh 风格
 *         `content.length > 0 ? content : null`，避免走 wrapper 剥离开销
 *     (b) 有无 aux 语义端点或独占 header（如有 → 补入 classifyRequest）
 */

import { extractUserQueryText } from "../common/user-query-extractor.js";
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const opencodeAdapter: AgentAdapter = {
  agentKind: "opencode",

  classifyRequest(_body?, _path?, _headers?) {
    // opencode 是通用 CLI，未观察到 fork/sidequery 语义信号；主对话 + 可能的
    // 系统摘要都当 main 处理，通用能力（injection + L0 + mem 拦截 + skill buffer）
    // 全开放。未来若发现 aux endpoint（如 title-gen / summary），在此扩展。
    return "main";
  },

  extractUserText(content) {
    // 主流场景：openai-compatible provider → content 是字符串
    if (typeof content !== "string") {
      // 未来若 opencode 改成 content-blocks 数组，走 default 兜底（拼接所有 text）
      return defaultAdapter.extractUserText(content);
    }
    // 保守剥离：无 wrapper 时原样返回，有 wrapper 时按 <user_query> 抽取
    const extracted = extractUserQueryText(content);
    return extracted.length > 0 ? extracted : null;
  },
};
