import type { GatewayPlatformAdapter } from "../../../../src/adapters/gateway-client/index.js";
import { createCodexMemoryAdapter } from "../adapter.js";
import { writePrompt } from "../prompt-cache.js";
import { isMainModule, readHookInput, writeHookOutput } from "./io.js";

export interface CodexRecallEvent {
  session_id?: string;
  prompt?: string;
}

export interface CodexRecallOutput {
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

interface RecallHookDependencies {
  createAdapter: (sessionId: string) => Pick<GatewayPlatformAdapter, "prefetch">;
  writePrompt: (sessionId: string, prompt: string) => Promise<void>;
  logger: Pick<Console, "warn">;
}

const defaultDependencies: RecallHookDependencies = {
  createAdapter: createCodexMemoryAdapter,
  writePrompt,
  logger: console,
};

export async function runRecallHook(
  event: CodexRecallEvent,
  deps: Partial<RecallHookDependencies> = {},
): Promise<CodexRecallOutput> {
  const dependencies = { ...defaultDependencies, ...deps };
  const sessionId = event.session_id?.trim();
  const prompt = event.prompt?.trim();
  if (!sessionId || !prompt) return {};

  try {
    await dependencies.writePrompt(sessionId, prompt);
  } catch (error) {
    dependencies.logger.warn(`[tdai-codex] Failed to cache prompt: ${String(error)}`);
  }

  let additionalContext = "";
  try {
    const recalled = await dependencies.createAdapter(sessionId).prefetch(prompt);
    additionalContext = recalled.context ?? "";
  } catch (error) {
    dependencies.logger.warn(`[tdai-codex] Recall failed: ${String(error)}`);
  }

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

if (isMainModule(import.meta.url)) {
  await writeHookOutput(await runRecallHook(await readHookInput<CodexRecallEvent>()));
}
