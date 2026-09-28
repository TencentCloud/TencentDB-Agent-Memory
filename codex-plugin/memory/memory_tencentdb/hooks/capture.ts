import type { GatewayPlatformAdapter } from "../../../../src/adapters/gateway-client/index.js";
import { createCodexMemoryAdapter } from "../adapter.js";
import { deletePrompt, readPrompt } from "../prompt-cache.js";
import { readLatestTranscriptTurn, type TranscriptTurn } from "../transcript.js";
import { isMainModule, readHookInput, writeHookOutput } from "./io.js";

export interface CodexCaptureEvent {
  session_id?: string;
  last_assistant_message?: string | null;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

export interface CodexCaptureOutput {
  continue: boolean;
}

interface CaptureHookDependencies {
  createAdapter: (sessionId: string) => Pick<GatewayPlatformAdapter, "captureTurn">;
  readPrompt: (sessionId: string) => Promise<string | null>;
  deletePrompt: (sessionId: string) => Promise<void>;
  readTranscript: (transcriptPath: string) => Promise<TranscriptTurn | null>;
  logger: Pick<Console, "warn">;
}

const defaultDependencies: CaptureHookDependencies = {
  createAdapter: createCodexMemoryAdapter,
  readPrompt,
  deletePrompt,
  readTranscript: readLatestTranscriptTurn,
  logger: console,
};

export async function runCaptureHook(
  event: CodexCaptureEvent,
  deps: Partial<CaptureHookDependencies> = {},
): Promise<CodexCaptureOutput> {
  const dependencies = { ...defaultDependencies, ...deps };
  const sessionId = event.session_id?.trim();
  if (!sessionId || event.stop_hook_active) return { continue: true };

  let cachedPrompt: string | null;
  try {
    cachedPrompt = await dependencies.readPrompt(sessionId);
  } catch (error) {
    dependencies.logger.warn(`[tdai-codex] Prompt cache read failed: ${String(error)}`);
    return { continue: true };
  }
  const eventAssistant = event.last_assistant_message?.trim() || "";
  let transcript: TranscriptTurn | null = null;
  if ((!cachedPrompt || !eventAssistant) && event.transcript_path) {
    try {
      transcript = await dependencies.readTranscript(event.transcript_path);
    } catch (error) {
      dependencies.logger.warn(`[tdai-codex] Transcript read failed: ${String(error)}`);
      return { continue: true };
    }
  }

  const userText = cachedPrompt ?? transcript?.userText ?? "";
  const assistantText = eventAssistant || transcript?.assistantText || "";
  if (!userText || !assistantText) return { continue: true };

  try {
    await dependencies.createAdapter(sessionId).captureTurn({ userText, assistantText });
    await dependencies.deletePrompt(sessionId);
  } catch (error) {
    dependencies.logger.warn(`[tdai-codex] Capture failed: ${String(error)}`);
  }

  return { continue: true };
}

if (isMainModule(import.meta.url)) {
  await writeHookOutput(await runCaptureHook(await readHookInput<CodexCaptureEvent>()));
}
