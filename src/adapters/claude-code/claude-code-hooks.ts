/**
 * Claude Code Hook 配置生成器。
 *
 * Claude Code 通过 .claude/settings.json 配置 hooks。
 *
 * 支持的 Hook 事件：
 * - BeforeRecall: 在构建 prompt 前获取记忆上下文
 * - AfterCapture: 在 LLM 回复后记录对话
 * - Stop: 会话结束时刷新记忆缓冲区
 */

/**
 * Claude Code hook 配置结构（.claude/settings.json 的 hooks 字段）。
 */
export interface ClaudeCodeHookConfig {
  hooks: {
    BeforeRecall?: ClaudeCodeHookEntry[];
    AfterCapture?: ClaudeCodeHookEntry[];
    Stop?: ClaudeCodeHookEntry[];
  };
}

export interface ClaudeCodeHookEntry {
  /** 正则匹配器（可选，限定 hook 适用的命令）。 */
  matcher?: string;
  /** 执行的 shell 命令。 */
  command: string;
}

/**
 * 生成 Claude Code BeforeRecall Hook。
 *
 * 在 prompt 构建前调用，注入相关记忆。
 */
export function generateBeforeRecallHook(
  gatewayUrl: string,
  apiKey?: string,
): ClaudeCodeHookEntry {
  const envPart = apiKey ? `TDAI_GATEWAY_API_KEY="${apiKey}" ` : "";
  return {
    matcher: "",
    command: `${envPart}npx @tencentdb-agent-memory/memory-tencentdb claude-code recall --gateway-url "${gatewayUrl}"`,
  };
}

/**
 * 生成 Claude Code AfterCapture Hook。
 *
 * 在 LLM 回复后调用，记录对话到记忆系统。
 */
export function generateAfterCaptureHook(
  gatewayUrl: string,
  apiKey?: string,
): ClaudeCodeHookEntry {
  const envPart = apiKey ? `TDAI_GATEWAY_API_KEY="${apiKey}" ` : "";
  return {
    matcher: "",
    command: `${envPart}npx @tencentdb-agent-memory/memory-tencentdb claude-code capture --gateway-url "${gatewayUrl}"`,
  };
}

/**
 * 生成 Claude Code Stop Hook。
 *
 * 会话结束时 flush 记忆缓冲区。
 */
export function generateStopHook(
  gatewayUrl: string,
  apiKey?: string,
): ClaudeCodeHookEntry {
  const envPart = apiKey ? `TDAI_GATEWAY_API_KEY="${apiKey}" ` : "";
  return {
    command: `${envPart}npx @tencentdb-agent-memory/memory-tencentdb claude-code end-session --gateway-url "${gatewayUrl}"`,
  };
}

/**
 * 生成完整的 Claude Code hook 配置。
 */
export function generateClaudeCodeHookConfig(
  gatewayUrl: string,
  apiKey?: string,
): ClaudeCodeHookConfig {
  return {
    hooks: {
      BeforeRecall: [generateBeforeRecallHook(gatewayUrl, apiKey)],
      AfterCapture: [generateAfterCaptureHook(gatewayUrl, apiKey)],
      Stop: [generateStopHook(gatewayUrl, apiKey)],
    },
  };
}
