import { appendTranscriptTurn } from "./pending.js";
import {
  clearSessionMarker,
  isTopLevelSession,
  markTopLevelSession,
} from "./session.js";

export type HookPayload = Record<string, unknown>;

export interface HookDependencies {
  rootDir: string;
  transcriptsRoot: string;
  appendTranscript?: typeof appendTranscriptTurn;
  spawnWorker: () => void;
  buildContext: () => Promise<string | undefined>;
  markTopLevel?: typeof markTopLevelSession;
  isTopLevel?: typeof isTopLevelSession;
  clearSession?: typeof clearSessionMarker;
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function handleHook(
  payload: HookPayload,
  deps: HookDependencies,
): Promise<Record<string, unknown>> {
  const event = text(payload.hook_event_name);
  const appendTranscript = deps.appendTranscript ?? appendTranscriptTurn;
  const markTopLevel = deps.markTopLevel ?? markTopLevelSession;
  const isTopLevel = deps.isTopLevel ?? isTopLevelSession;
  const clearSession = deps.clearSession ?? clearSessionMarker;
  const now = deps.now ?? Date.now;

  try {
    const conversationId =
      text(payload.conversation_id) ?? text(payload.session_id);

    if (event === "sessionStart") {
      if (!conversationId) throw new Error("sessionStart conversation_id is missing");
      if (payload.is_background_agent !== false) {
        await clearSession(deps.rootDir, conversationId);
        return {};
      }
      await markTopLevel(deps.rootDir, conversationId);
      const context = await deps.buildContext();
      return context ? { additional_context: context } : {};
    }

    if (event === "sessionEnd") {
      deps.spawnWorker();
      if (conversationId) await clearSession(deps.rootDir, conversationId);
      return {};
    }

    if (event === "stop") {
      try {
        if (!conversationId) throw new Error("stop conversation_id is missing");
        if (!(await isTopLevel(deps.rootDir, conversationId))) {
          deps.log("stop_skipped_unclassified");
          deps.spawnWorker();
          return {};
        }
        const generationId = text(payload.generation_id);
        if (!generationId) throw new Error("stop generation_id is missing");
        const transcriptPath = text(payload.transcript_path);
        if (!transcriptPath) throw new Error("stop transcript_path is missing");
        await appendTranscript(
          deps.rootDir,
          deps.transcriptsRoot,
          transcriptPath,
          conversationId,
          generationId,
          text(payload.status) ?? "completed",
          now(),
        );
      } catch (error) {
        deps.log("stop_capture_error", {
          error: error instanceof Error
            ? error.message.slice(0, 300)
            : String(error).slice(0, 300),
        });
      }
      deps.spawnWorker();
      return {};
    }
  } catch (error) {
    deps.log("hook_error", {
      event,
      error: error instanceof Error
        ? error.message.slice(0, 300)
        : String(error).slice(0, 300),
    });
  }

  return {};
}
