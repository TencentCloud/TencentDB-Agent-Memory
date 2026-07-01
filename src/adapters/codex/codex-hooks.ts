/**
 * Codex Hook 配置生成器。
 *
 * Codex 支持以下 Hook 事件：
 * - UserPromptSubmit: 用户提交 prompt 前触发 → 注入记忆上下文
 * - Stop: agent 完成对话时触发 → 记录对话
 *
 * 配置方式：
 * 1. 将 hook 脚本放入 Codex hooks 目录
 * 2. 在 config.json 中引用 hook
 */

/**
 * Codex hook 配置结构。
 */
export interface CodexHookConfig {
  hooks: {
    UserPromptSubmit?: CodexHookEntry[];
    Stop?: CodexHookEntry[];
  };
}

export interface CodexHookEntry {
  /** Hook 类型：command（执行外部命令）。 */
  type: "command";
  /** 执行的 shell 命令。 */
  command: string;
  /** 超时时间（毫秒）。 */
  timeout?: number;
}

/**
 * 生成 Codex Recall Hook 配置。
 *
 * 在 UserPromptSubmit 时调用，将记忆上下文注入到 system prompt 中。
 */
export function generateRecallHook(
  gatewayUrl: string,
  apiKey?: string,
): CodexHookEntry {
  const envPart = apiKey ? `TDAI_GATEWAY_API_KEY="${apiKey}" ` : "";
  const cmd = `${envPart}npx @tencentdb-agent-memory/memory-tencentdb codex recall --gateway-url "${gatewayUrl}"`;
  return { type: "command", command: cmd, timeout: 10000 };
}

/**
 * 生成 Codex Capture Hook 配置。
 *
 * 在 Stop 时调用，将对话记录到记忆系统中。
 */
export function generateCaptureHook(
  gatewayUrl: string,
  apiKey?: string,
): CodexHookEntry {
  const envPart = apiKey ? `TDAI_GATEWAY_API_KEY="${apiKey}" ` : "";
  const cmd = `${envPart}npx @tencentdb-agent-memory/memory-tencentdb codex capture --gateway-url "${gatewayUrl}"`;
  return { type: "command", command: cmd, timeout: 15000 };
}

/**
 * 生成完整的 Codex hook 配置对象。
 */
export function generateCodexHookConfig(
  gatewayUrl: string,
  apiKey?: string,
): CodexHookConfig {
  return {
    hooks: {
      UserPromptSubmit: [generateRecallHook(gatewayUrl, apiKey)],
      Stop: [generateCaptureHook(gatewayUrl, apiKey)],
    },
  };
}
