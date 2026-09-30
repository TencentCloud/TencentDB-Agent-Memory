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
    // 同一轮用户消息里的所有文本块（顺序不固定，命令可能不在最后一块）
    const allTexts: string[] = [];

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
          allTexts.push(b.text);
        }
      }
      text = texts.length > 0 ? texts.join("\n") : null;
    } else if (Array.isArray((body as any).messages)) {
      // CC/CB/dsh 用 body.messages[]
      const messages = (body as any).messages as any[];
      if (messages.length === 0) return false;
      // 真机上 CC 会在用户输入后面再挂一条 `role:"system"` 的提示
      // （实测形如 `<total_tokens>15000000 tokens left</total_tokens>`），
      // 于是"最后一条就是用户消息"的前提不成立、命令被整条漏掉。
      //
      // 于是从尾部往回找"本 turn 的用户输入"，一路跳过非 user 消息（上面那条 system 提示）
      // 与没有文本的占位消息，最多回看 6 条，避免历史里的旧命令被重放触发。
      //
      // 但"往回跳过没有文本的消息"这条规则会误伤表单续接：客户端把表单选择以**工具回执**
      // 发回来，回执里没有用户键入的文本，于是回看会越过它、命中会话更早那条
      // `mem:session-reset`，把一条已经执行过的命令当成新命令重放 —— 状态被打回
      // uninitialized，同一张表单被反复弹（真机现象：CC 上资产关联问句连弹两遍、
      // 第一次的选择被第二次重置覆盖；Hermes 上更明显，连问三次）。
      // 工具回执有两种形态，都要挡住：
      //   - OpenAI Chat：独立角色 `{role:"tool", tool_call_id, content}`（Hermes / workbuddy …）
      //   - Anthropic：`{role:"user", content:[{type:"tool_result", …}]}`
      // 遇到任一种都判否：本 turn 是工具/表单的续接，不是用户新输入。
      const hasText = (m: any): boolean => {
        if (!m || m.role !== "user") return false;
        if (typeof m.content === "string") return m.content.trim().length > 0;
        if (!Array.isArray(m.content)) return false;
        return m.content.some(
          (b: any) => b && (b.type === "text" || b.type === "input_text") && typeof b.text === "string" && b.text.trim().length > 0,
        );
      };
      const isToolReply = (m: any): boolean =>
        !!m && typeof m === "object" && (m.role === "tool" || m.role === "function");
      const hasToolResult = (m: any): boolean => {
        if (!m || m.role !== "user" || !Array.isArray(m.content)) return false;
        return m.content.some(
          (b: any) => b && typeof b === "object" && (b.type === "tool_result" || b.type === "function_call_output"),
        );
      };
      let last: any = undefined;
      for (let i = messages.length - 1; i >= 0 && i >= messages.length - 6; i--) {
        const m = messages[i];
        if (isToolReply(m)) return false;
        if (!m || m.role !== "user") continue;
        if (hasText(m)) { last = m; break; }
        if (hasToolResult(m)) return false;
      }
      if (!last) return false;
      text = adapter.extractUserText(last.content);
      if (Array.isArray(last.content)) {
        for (const block of last.content as unknown[]) {
          const b = block as Record<string, unknown> | null | undefined;
          if (b && typeof b === "object" && (b.type === "text" || b.type === "input_text") && typeof b.text === "string") {
            allTexts.push(b.text);
          }
        }
      }
    } else {
      return false;
    }

    if (!text) return false;

    // 客户端会往用户消息里掺自己的内容：Claude Code 2.x 把 `<system-reminder>…` 与用户输入
    // 分成多个 text 块（顺序不固定），也可能在同一块里换行追加。这两种情况下，
    // "按整段文本解析命令"会得到 command="session-reset\n<system-reminder>…"（或干脆取到
    // reminder 那一块），与 "session-reset" 不相等，reset 永远不会触发——真机表现是用户发了
    // mem:session-reset，会话仍停在 bypassed/pending，模型把它当普通提问回答。
    //
    // 因此：先看**首行**是否恰好是命令（不放松成"包含"，免得把"mem:session-reset 是什么意思"
    // 这类正常提问也拦掉），并允许命令出现在任意一个 text 块里。
    const isResetLine = (value: string | null | undefined): boolean =>
      typeof value === "string" &&
      value.trim().split(/\r?\n/, 1)[0].trim().toLowerCase() === "mem:session-reset";

    if (isResetLine(text)) return true;
    for (const candidate of allTexts) if (isResetLine(candidate)) return true;

    // 兜底：保持原有严格解析（含参数校验）不变。
    const parsed = parseCommandFromText(text);
    return parsed?.command === "session-reset";
  } catch {
    return false;
  }
}
