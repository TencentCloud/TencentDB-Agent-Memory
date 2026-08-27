/**
 * Agent Adapter — 按 CC 客户端 / CodeBuddy / 其他 IDE 客户端的不同行为
 * 抽象出一层适配。
 *
 * 背景：不同客户端往请求里塞的东西不一样：
 *   - Claude Code (anthropic 协议): user content 是多 text block 数组，前面
 *     塞 <system-reminder> / <local-command-*> 等元数据，最后一个 text block
 *     才是用户输入；fork 类请求 (SUGGESTION/RECAP/COMPACT) 在 cache_control
 *     marker 位置上跟主对话不同 (n-2 vs n-1)。
 *   - CodeBuddy (openai 协议): user content 常是字符串，可能夹杂 CB 内部
 *     标签 —— 结构和 CC 差异大。
 *   - 其他（cursor / windsurf / 自定义 SDK）: 未研究。
 *
 * proxy 里三个地方需要按客户端适配：
 *   1. 分类请求类别 (main / fork / sidequery) —— 决定后续 stage 走哪条路径
 *   2. 从 user message content 提取"用户真正键入的文本" —— 供 mem 命令识别 /
 *      skill buffer 归一化使用
 *
 * 通用能力（skill_buffer 写入、L0 记忆、mem 拦截）对所有客户端都要开放，
 * 只是**取用户输入的规则**和**分类规则**按 agent 适配。
 */

export type AgentKind = "claude-code" | "codebuddy" | "codex" | "workbuddy" | "dsh" | "opencode" | "pi" | "unknown";

export type RequestKind = "main" | "fork" | "sidequery" | "auxiliary";

export interface AgentAdapter {
  /** 客户端类型标识，从 URL 前缀映射来。 */
  readonly agentKind: AgentKind;

  /**
   * 分类请求类别。用于 handler 决定后续 stage 是否绕过 injection / mem 拦截 /
   * L0 / skill buffer 等业务副作用。
   *
   * - claude-code: 按 cache_control marker 位置 + tools/thinking 兜底三分
   *   （详见 docs/design/2026-07-30-cc-request-routing-plan.md）
   * - codebuddy / unknown: 恒返回 "main" —— 未研究该客户端的分类规则，保守走
   *   等价现状的老链路（不启用分流）
   */
  classifyRequest(
    body: Record<string, unknown>,
    path?: string,
    headers?: Record<string, string>,
  ): RequestKind;

  /**
   * 从 user message 的 content 里提取"用户真正键入的文本"。
   *
   * - claude-code: 取最后一个 type:"text" block（跳过前面的 <system-reminder>
   *   等 CC 内部元数据，跳过 tool_result / image / thinking 等其它 block 类型）
   * - codebuddy / unknown: 保守走"content 转 string"的老逻辑，等价现状
   *
   * 返回 null 表示"content 里没有用户键入的文本"（比如全是 tool_result）。
   */
  extractUserText(content: unknown): string | null;
}
