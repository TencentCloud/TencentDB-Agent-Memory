/**
 * Hooks 共享运行时 —— stdin 读取、客户端/binding 构造、输出工具。
 *
 * 三个钩子（recall/capture/session-end）共用此模块，避免重复样板。
 * 设计要点：
 *   - 钩子是宿主事件驱动的短命进程，任何异常都不应阻塞 Claude Code 对话
 *     （记忆永不阻塞，对齐 event-binding.ts 契约）。
 *   - 日志一律走 stderr（stdout 留给结构化 JSON 输出，避免污染 Claude 上下文）。
 *   - 暴露可测的纯函数（readStdinJson / buildBinding / emitAdditionalContext），
 *     钩子入口只做「拼装 + 调 main」。
 */

import type { TdaiClient } from "../../../sdk/client.js";
import { TdaiHttpClient } from "../../../sdk/client.js";
import { ClaudeCodeEventBinding } from "../claude-code-binding.js";
import { loadClaudeCodeConfig, resolveSessionKey } from "../config.js";
import type { ClaudeCodeAdapterConfig } from "../config.js";

// ============================
// 类型：Claude Code hooks 公共输入字段
// ============================

/**
 * Claude Code 钩子 stdin 的公共字段。
 *
 * 字段名对齐官方 hooks reference（UserPromptSubmit / Stop / SessionEnd 共有）：
 *   - session_id      当前会话 ID（用作 L0 sessionKey 的首选）
 *   - transcript_path 当前会话的 JSONL 转录文件路径（Stop/capture 用它取对话）
 *   - cwd             Claude Code 工作目录（sessionKey 回退时归一化用）
 *   - hook_event_name 触发的事件名（校验用）
 *
 * 各事件额外字段由具体钩子自行声明（如 UserPromptSubmit.prompt、Stop.stop_hook_active）。
 * 注：字段名为 Claude Code 官方约定（snake_case），此处保持原样不做转换。
 */
export interface ClaudeCodeHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

// ============================
// stdin 读取
// ============================

/**
 * 从 stdin 读取全部内容并解析为 JSON。
 *
 * 钩子由 Claude Code 启动，stdin 收到的是单条 JSON 对象（UTF-8）。
 * 空 stdin / 非法 JSON → 返回 null（钩子应静默退出，不阻塞对话）。
 *
 * 暴露为可注入以便测试：测试时直接传字符串，绕过 process.stdin。
 */
export async function readStdinJson(stdin?: string): Promise<ClaudeCodeHookInput | null> {
  const raw = stdin ?? (await readStreamToEnd(process.stdin));
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ClaudeCodeHookInput)
      : null;
  } catch {
    return null;
  }
}

function readStreamToEnd(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk) => (buf += chunk));
    stream.on("end", () => resolve(buf));
    stream.on("error", () => resolve(""));
  });
}

// ============================
// 客户端 / binding 构造
// ============================

/**
 * 用当前 env 构造一个 TdaiHttpClient（生产钩子入口用）。
 *
 * 配置来自 loadClaudeCodeConfig()——读取 TDAI_GATEWAY_BASE_URL / TDAI_MCP_API_KEY 等 env。
 * 测试时跳过此函数，直接传 mock client 给 main()。
 */
export function buildClient(): TdaiHttpClient {
  const cfg = loadClaudeCodeConfig();
  return new TdaiHttpClient({
    baseUrl: cfg.gatewayBaseUrl,
    apiKey: cfg.apiKey,
  });
}

/**
 * 用给定 client + env 配置构造 ClaudeCodeEventBinding。
 *
 * 暴露 config 出来供钩子取 userId / sessionKey（binding 内部也用，但钩子入口
 * 需要先算 sessionKey 才能调 main，所以这里同时返回 config）。
 */
export function buildBinding(client: TdaiClient): {
  binding: ClaudeCodeEventBinding;
  config: ClaudeCodeAdapterConfig;
} {
  const config = loadClaudeCodeConfig();
  return { binding: new ClaudeCodeEventBinding(client, config), config };
}

/**
 * 从钩子输入解析 sessionKey + sessionId + userId，组成 HostEventContext 的公共部分。
 *
 * sessionKey 策略（对齐 config.ts 的 resolveSessionKey）：
 *   - 输入的 session_id 非空 → 直接用作 sessionKey
 *   - 否则回退 `cwd::YYYY-MM-DD`
 */
export function resolveContext(input: ClaudeCodeHookInput, config: ClaudeCodeAdapterConfig): {
  sessionKey: string;
  sessionId: string;
  userId: string;
} {
  const sessionId = input.session_id?.trim() ?? "";
  const sessionKey = resolveSessionKey(sessionId, input.cwd);
  return { sessionKey, sessionId, userId: config.userId };
}

// ============================
// 输出工具
// ============================

/**
 * UserPromptSubmit 钩子的结构化输出：把 additionalContext 注入 Claude 上下文。
 *
 * 格式对齐 Claude Code hooks 官方约定（hookSpecificOutput.hookEventName +
 * additionalContext）。空 additionalContext 时输出空对象（无副作用）。
 *
 * 必须写 stdout（且仅写这一条 JSON），stderr 留给日志。
 */
export function emitAdditionalContext(additionalContext: string): void {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

/** 钩子通用日志（走 stderr，不污染 stdout/Claude 上下文）。 */
export function log(msg: string): void {
  process.stderr.write(`[memory-tdai][hook] ${msg}\n`);
}

/**
 * 钩子入口的安全包装：任何异常都吞掉、记 stderr、退出码 0。
 *
 * 记忆永不阻塞对话——即使 Gateway 宕机、stdin 非法、transcript 读失败，
 * 钩子也必须让 Claude Code 继续工作。
 */
export async function runHookSafely(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${name} error (suppressed, will not block): ${msg}`);
  }
  // 永不抛出、永不非零退出
}
