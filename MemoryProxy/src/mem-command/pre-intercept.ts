/**
 * mem:session-reset 的前置拦截判定.
 *
 * 背景:所有 mem 命令原本在各 handler 里 session-init 段**之后**才被识别
 * (`anthropicHandler.ts:869-1000` / `handler.ts:922-1000` /
 * `codexHandler.ts:609-680` / `workbuddyHandler.ts:1111-1180`)。这套顺序
 * 对 sync / create-skill 是合理的 —— 它们依赖 sessionInfo。但 session-reset
 * 需要在 **uninitialized / pending_* / initialized / bypassed** 四种起始状态
 * 都能生效:
 *
 *   - uninitialized:state machine 会把 "mem:session-reset" 当成"用户第一句"
 *     用作 form 反射数据的 asset_confirm 分支不适用,但至少会先弹一次 form,
 *     用户看到 form 反而困惑
 *   - pending_*:state machine 会把它当成"用户对 form 的答复",走 parseFormAnswer
 *     → unrecognized → session bypass,reset 命令永远拦不到
 *   - initialized / bypassed:老 mem-command 拦截段能识别,但拿掉 "会话未初始化
 *     命令不可用" gate 后行为一致。这两种也走前置拦截更简洁
 *
 * 折中方案:只对 session-reset 加前置拦截 —— 其他 mem 命令不动。这个函数
 * 就是判"这个请求是不是 session-reset",handler 里前置一句 if 决定要不要
 * 短路。
 */

import { parseCommandFromText } from "./parser.js";
import { resolveAgentAdapter } from "../agent-adapters/index.js";

/**
 * 判断请求 body 里最后一条 user 消息是不是 `mem:session-reset`.
 *
 * 兼容 body.messages[] (CC/CB/dsh) 和 body.input[] (Codex/WB) 两种形态。
 * 内部用对应 adapter 的 `extractUserText` 提取纯文本,与既有 mem-command
 * 拦截段保持一致的文本提取语义。
 *
 * 不抛错:任何异常 / 缺字段一律 false,让原链路继续跑。
 */
export function isSessionResetCommand(
  body: Record<string, unknown> | null | undefined,
  agentSource: string,
): boolean {
  if (!body) return false;

  try {
    const adapter = resolveAgentAdapter(agentSource);
    let text: string | null = null;

    // Codex / WorkBuddy 用 body.input[] (Responses API)
    if (Array.isArray((body as any).input)) {
      const input = (body as any).input as any[];
      if (input.length === 0) return false;
      // 只识别"最新一条 input item 是 role=user message"的情况;
      // 若最新一条是 function_call_output 说明当前是 form 交互中,
      // codex 客户端 replay 整个历史 input 包括最早的 mem:session-reset —
      // 此时不应重复触发 pre-hook, 否则 state 会被无限打回 uninitialized 死循环。
      const lastItem = input[input.length - 1] as Record<string, unknown> | null | undefined;
      if (!lastItem || typeof lastItem !== "object") return false;
      if (lastItem.type !== "message" || lastItem.role !== "user") return false;
      // 直接从最后一条 message 抽 text, 不复用 extractUserText (它会向前扫)
      const content = lastItem.content;
      if (!Array.isArray(content)) return false;
      const texts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown> | null | undefined;
        if (b && typeof b === "object" && b.type === "input_text" && typeof b.text === "string") {
          texts.push(b.text);
        }
      }
      text = texts.length > 0 ? texts.join("\n") : null;
    } else if (Array.isArray((body as any).messages)) {
      // CC/CB/dsh 用 body.messages[]
      const messages = (body as any).messages as any[];
      if (messages.length === 0) return false;
      // 最后一条 user
      const last = messages[messages.length - 1];
      if (!last || last.role !== "user") return false;
      text = adapter.extractUserText(last.content);
    } else {
      return false;
    }

    if (!text) return false;
    const parsed = parseCommandFromText(text);
    return parsed?.command === "session-reset";
  } catch {
    return false;
  }
}
