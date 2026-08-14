/**
 * mem-command 模块类型定义
 */

import type { ProxyConfig, MemCommandConfig } from "../types.js";

export interface MemCommandContext {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  userId: string;
  apiKey: string;
  sessionInfo: Record<string, unknown>;
  protocol: "anthropic" | "openai" | "responses";
  stream: boolean;
  /** 命令参数（如 create-skill 的提示词） */
  args: string;
  /** 请求是否开启了 extended thinking（Anthropic 专用） */
  thinking?: boolean;
}

export interface MemCommandResult {
  success: boolean;
  /** 用户可读的结果文本（写入 L0 / 展示给用户） */
  messageText: string;
  /** 结构化数据（可选） */
  data?: Record<string, unknown>;
  /** 构造好的 HTTP Response（已按协议格式伪造） */
  response: Response;
}

export type { MemCommandConfig };
