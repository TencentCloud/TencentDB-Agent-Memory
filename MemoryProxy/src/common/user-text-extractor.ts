/**
 * User message content 里"用户真正键入的文本"提取器。
 *
 * 背景：Claude Code CLI 每条 user message 的 `content` 常常是多 block 数组，
 * 前面塞 `<system-reminder>` 等 CC 内部环境元数据，最后一个 `type:"text"` block
 * 才是用户真实输入。tool_result / image / thinking 等其它 block 不是用户键入的。
 *
 * 使用点（**仅** anthropic 协议下、CC 客户端路径调用）：
 *   - `mem-command/parser.ts` — 判断是否 `mem:` 命令前缀
 *   - `skill/normalize-conversation.ts` (anthropic user 分支) — 只推最后一段用户话给 skill core
 *
 * CodeBuddy (openai 协议) 保持现有逻辑不动，不复用本 helper。
 */

export function extractLastUserText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  // 从后往前扫，找第一个 type:"text" 且 text 为 string 的 block
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i];
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") continue;
    return block.text;
  }
  return null;
}
