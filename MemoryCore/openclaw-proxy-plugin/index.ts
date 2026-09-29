/**
 * MemoryProxy Session Bridge — 仅注册 OpenClaw provider 的插件。
 *
 * 将每个原生 OpenClaw 会话映射为 Proxy 对话身份：
 *   options.sessionId → x-conversation-id: openclaw-<sha256(UTF-8 sessionId)>
 *
 * 插件仅承载路由和动态请求头，召回、采集与注入留在 Proxy 服务端，与 pi-plugin 分工一致。
 */

import type { OpenClawPluginApi, ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/core";
import { createHash } from "node:crypto";

// SDK 不单独导出 streamFn 的 options 类型，从上下文类型提取以保持契约一致。
type ProviderStreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;
type ProviderStreamOptions = NonNullable<Parameters<ProviderStreamFn>[2]>;

const PROVIDER_ID = "memory-proxy";
const CONVERSATION_HEADER = "x-conversation-id";

/**
 * 将 options 的 x-conversation-id 设置为 `openclaw-<sha256(UTF-8 sessionId)>`。
 * 固定 ASCII 标识兼容合法 Unicode 会话 ID，且不直接暴露原始 ID。
 *
 * sessionId 由 OpenClaw 提供，同一原生会话跨窗口及重启后保持相同对话身份。
 * 缺少 sessionId 时原样返回，不生成随机兜底身份，避免将同一会话拆成多个对话。
 */
export function withOpenClawConversationId(
  options: ProviderStreamOptions | undefined,
): ProviderStreamOptions | undefined {
  const sessionId = options?.sessionId?.trim();
  // 显式检查 options，以便为后续代码收窄类型。
  if (!sessionId || !options) return options;

  // 忽略大小写删除既有对话请求头，避免静态旧值覆盖原生会话身份。
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== CONVERSATION_HEADER,
    ),
  );

  return {
    ...options,
    headers: {
      ...headers,
      [CONVERSATION_HEADER]: `openclaw-${createHash("sha256").update(sessionId, "utf8").digest("hex")}`,
    },
  };
}

export function wrapMemoryProxyStream(
  ctx: ProviderWrapStreamFnContext,
  logger: OpenClawPluginApi["logger"],
): ProviderStreamFn | undefined {
  if (!ctx.streamFn) return undefined;
  const streamFn = ctx.streamFn;

  return (
    model: Parameters<ProviderStreamFn>[0],
    context: Parameters<ProviderStreamFn>[1],
    options?: ProviderStreamOptions,
  ) => {
    if (!options?.sessionId?.trim()) {
      logger.warn(
        "[memory-proxy-session-bridge] Missing native options.sessionId; forwarding without x-conversation-id",
      );
    }
    return streamFn(model, context, withOpenClawConversationId(options));
  };
}

export default function register(api: OpenClawPluginApi) {
  api.registerProvider({
    id: PROVIDER_ID,
    label: "MemoryProxy",
    auth: [],
    wrapStreamFn: (ctx) => wrapMemoryProxyStream(ctx, api.logger),
  });
}
