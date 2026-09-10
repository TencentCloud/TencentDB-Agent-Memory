export type InteractiveInitTool = "ask_user_question" | "clarify";

export interface SessionInitCapability {
  canInteractiveInit: boolean;
  interactiveTool?: InteractiveInitTool;
}

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const entry = tool as {
      name?: unknown;
      function?: { name?: unknown };
    };
    const name = entry.function?.name ?? entry.name;
    return typeof name === "string" ? [name] : [];
  });
}

export function resolveSessionInitCapability(
  agentSource: string,
  tools: unknown,
): SessionInitCapability {
  const names = toolNames(tools);
  if (agentSource === "hermes") {
    return names.includes("clarify")
      ? { canInteractiveInit: true, interactiveTool: "clarify" }
      : { canInteractiveInit: false };
  }
  if (agentSource === "dsh") {
    return names.includes("ask_user_question")
      ? { canInteractiveInit: true, interactiveTool: "ask_user_question" }
      : { canInteractiveInit: false };
  }
  return { canInteractiveInit: true };
}
