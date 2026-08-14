// Field names follow Claude-Code-compatible hooks protocol; verify against real Trae at integration time.
import type { TdaiBridge } from "../tdai-bridge/tdai-bridge.js";

export type TraeHookEvent = "SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd";

export interface TraeHookInput {
  prompt?: string;
  last_assistant_message?: string;
  // ponytail: Trae 实测字段补在这里(见上方实测前置)
  [k: string]: unknown;
}

export interface TraeHookOutput {
  additionalContext?: string;
}

// 移植自 #517:有界注入,防 context 爆炸
const MAX_CONTEXT_CHARS = 4000;

export async function handleTraeHook(
  event: TraeHookEvent,
  input: TraeHookInput,
  bridge: TdaiBridge,
  sessionKey: string = String(process.env.TRAE_SESSION_KEY ?? "trae-default")
): Promise<TraeHookOutput> {
  switch (event) {
    case "SessionStart":
    case "UserPromptSubmit": {
      const query = input.prompt ?? "";
      if (!query) return {};
      const { context } = await bridge.recall(query, sessionKey);
      if (!context) return {};
      // ponytail: 硬截断上限;超长则尾部省略
      const bounded = context.length > MAX_CONTEXT_CHARS
        ? context.slice(0, MAX_CONTEXT_CHARS) + "\n…(truncated)"
        : context;
      return { additionalContext: bounded };
    }
    case "Stop": {
      const assistantText = input.last_assistant_message ?? "";
      // ponytail: userText 在 Stop 事件未必可得;取上轮缓存或空(实现期按 Trae 实测补)
      await bridge.capture({ userText: "", assistantText }, sessionKey);
      return {};
    }
    case "SessionEnd":
      await bridge.endSession(sessionKey);
      return {};
  }
}
