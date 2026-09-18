/**
 * Capture: send the transcript delta since the marker to L0 via `/v3/conversation/add`.
 *
 * At Stop the delta is the finished turn, sent as batches of at most 100
 * messages; at SessionEnd it is whatever is still unsent. A batch that does
 * not land leaves the marker at the last batch that did, so the next hook
 * retries from there. Turns captured by the plain prompt+reply path (no
 * transcript available at the time) contribute only their tool traffic later.
 */

import type { V3MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import type { PluginState } from "./state.js";
import {
  normalizeTranscript,
  promptIdsIn,
  readTranscriptEntries,
  resolveTranscriptPath,
  sliceAfter,
  splitBatches,
} from "./transcript.js";

export type TranscriptDeltaOutcome = "no-transcript" | "nothing-new" | "partial" | "complete";

export interface TranscriptDeltaInput {
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
  /** Wall-clock budget; batches beyond it wait for the next Stop or SessionEnd. */
  budgetMs: number;
  claudeConfigDir?: string;
}

export interface CaptureDeps {
  client: V3MemoryClient;
  state: PluginState;
  log: (message: string) => void;
}

export async function sendTranscriptDelta(deps: CaptureDeps, delta: TranscriptDeltaInput): Promise<TranscriptDeltaOutcome> {
  const transcriptPath = await resolveTranscriptPath({
    transcriptPath: delta.transcriptPath,
    cwd: delta.cwd,
    sessionId: delta.sessionId,
    claudeConfigDir: delta.claudeConfigDir,
  });
  if (!transcriptPath) return "no-transcript";

  const entries = sliceAfter(await readTranscriptEntries(transcriptPath), await deps.state.getTranscriptMarker(delta.sessionId));
  if (entries.length === 0) return "nothing-new";

  const capturedPromptIds = new Set<string>();
  for (const promptId of promptIdsIn(entries)) {
    if (await deps.state.isCaptured(delta.sessionId, promptId)) capturedPromptIds.add(promptId);
  }

  const messages = normalizeTranscript(entries, { sessionId: delta.sessionId, capturedPromptIds });
  const lastEntryUuid = entries[entries.length - 1].uuid;
  if (messages.length === 0) {
    await deps.state.setTranscriptMarker(delta.sessionId, lastEntryUuid);
    return "nothing-new";
  }

  const deadline = Date.now() + delta.budgetMs;
  const batches = splitBatches(messages);
  for (const [index, batch] of batches.entries()) {
    if (Date.now() > deadline) {
      deps.log(`transcript capture stopped at budget: ${batches.length - index} batch(es) left for session ${delta.sessionId}`);
      return "partial";
    }
    try {
      await deps.client.addConversation({
        session_id: delta.sessionId,
        messages: batch.map(({ sourceUuid: _sourceUuid, ...message }) => message),
      });
    } catch (error) {
      deps.log(`transcript capture failed open: ${error instanceof Error ? error.message : String(error)}`);
      return "partial";
    }
    const last = batch[batch.length - 1];
    await deps.state.setTranscriptMarker(delta.sessionId, index === batches.length - 1 ? lastEntryUuid : last.sourceUuid);
  }
  return "complete";
}

/** The plain path when no transcript can be read: prompt and final reply only. */
export async function sendPlainTurn(deps: CaptureDeps, input: {
  sessionId: string;
  promptId: string;
  prompt: string;
  reply: string;
}): Promise<boolean> {
  try {
    await deps.client.addConversation({
      session_id: input.sessionId,
      messages: [
        { id: `claude-code:${input.sessionId}:${input.promptId}:user`, role: "user", content: input.prompt },
        { id: `claude-code:${input.sessionId}:${input.promptId}:assistant`, role: "assistant", content: input.reply },
      ],
    });
    return true;
  } catch (error) {
    deps.log(`capture failed open: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
