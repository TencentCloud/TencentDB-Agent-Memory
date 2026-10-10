/**
 * stages/response-tail-fix.ts — 客户端特化的响应尾字节兼容层。
 *
 * 上游合入的 a08d67e9 dsh SSE 严格 parser 修复原本内联在 anthropicHandler.ts,
 * 迁到 pipeline 后应按重构标准抽成 stage 让所有 runner 都能复用同一份实现,
 * 而非在 anthropic runner 里定义了 openai-chat 未来无法复用。
 *
 * 目前只有一条规则 (dsh v0.2 需要 SSE 尾补 \n), 未来若有其他客户端 quirk,
 * 都在这里扩展 (加 case), caller 只调 stageResponseTailFix() 就够。
 */

/**
 * 客户端特化 SSE 尾字节修补。
 *
 * 目前唯一规则:
 *   agentSource === "dsh" + isStream + response.body 非空 →
 *     在 stream 末尾补一个 \n, 让最后一个 event 满足 SSE `\n\n` 结束规范。
 *
 * 背景 (a08d67e9):
 *   dsh v0.2 llm-deepseek-api-key adapter 的 SSE parser (源码
 *   `packages/llm/llm-deepseek/src/translate.ts:165`) 严格判 `\n\n` 结束 event,
 *   proxy 的 mem-command shared response builder (mem-command/response-builder.ts)
 *   末尾 `lines.join('\n')` 只补一个 `\n`, dsh 收不到 message_stop → STREAM_CLOSED。
 *   CC / Anthropic 官方 SDK parser 宽松, 单 `\n` 也能收到 terminal event, 所以
 *   shared builder 不能动 (改了会影响 CC), 由本 stage 只对 dsh 补一字节。
 *
 * CC / CB / WB / opencode / codex 完全零影响 (首行硬 gate 挡住)。
 */
export function stageResponseTailFix(
  response: Response,
  agentSource: string,
  isStream: boolean,
): Response {
  if (agentSource !== "dsh" || !isStream || !response.body) return response;
  const src = response.body;
  const patched = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = src.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        // 补上末尾的第 2 个 `\n`, 让最后一个 event 满足 SSE `\n\n` 结束规范
        controller.enqueue(new TextEncoder().encode("\n"));
      } catch (err) {
        controller.error(err);
        return;
      } finally {
        reader.releaseLock();
      }
      controller.close();
    },
  });
  const headers = new Headers(response.headers);
  return new Response(patched, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
