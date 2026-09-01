/**
 * Detect OpenAI-protocol clients that cannot render the native session-init
 * question tool.
 *
 * dsh historically omits `tools` on requests that still participate in its
 * normal flow, so preserve that behaviour. Cursor, on the other hand, exposes
 * AskQuestion in every captured interactive request; a missing/empty preset is
 * therefore a headless request and must not receive a synthetic tool call.
 */
export function isOpenAIHeadless(
  agentSource: string,
  body: { tools?: unknown },
): boolean {
  if (agentSource !== "dsh" && agentSource !== "cursor") return false;

  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return agentSource === "cursor";
  }

  const expectedTool = agentSource === "cursor" ? "AskQuestion" : "ask_user_question";
  return !tools.some((tool) => {
    const candidate = tool as { function?: { name?: string }; name?: string };
    return (candidate.function?.name ?? candidate.name) === expectedTool;
  });
}

export function buildHeadlessSessionResetMessage(agentSource: string): string {
  const toolName = agentSource === "cursor" ? "AskQuestion" : "ask_user_question";
  return `⚠️ mem:session-reset 不支持 ${agentSource} headless 模式。\n\n`
    + `${agentSource} 客户端在 headless / no-preset 场景下不挂 ${toolName} tool，无法弹出资产选择表单。\n`
    + `请在带 ${toolName} preset 的 ${agentSource} 环境下使用。`;
}
