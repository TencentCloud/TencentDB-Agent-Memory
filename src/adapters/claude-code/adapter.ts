import type { AdapterRuntime, MemoryClient, PlatformAdapter } from "../sdk/types.js";
import type { ClaudeCodeHookInput, ClaudeCodeHookOutput } from "./hooks.js";
import { ClaudeCodeSessionState, claudeCodeSessionKey } from "./session.js";
import {
  normalizeTranscript,
  promptIdsIn,
  readTranscriptEntries,
  resolveTranscriptPath,
  sliceAfter,
  splitBatches,
} from "./transcript.js";

export type ClaudeCodeHookHandler = (input: ClaudeCodeHookInput) => Promise<ClaudeCodeHookOutput>;

export interface ClaudeCodePlatformAdapterOptions {
  stateDir?: string;
  /**
   * Transcript capture: send the session transcript delta (tool calls, tool
   * results, intermediate assistant text) to L0, one turn at each Stop and the
   * remainder at SessionEnd. Defaults to on; set
   * `TDAI_CLAUDE_CODE_TRANSCRIPT_CAPTURE=off` to disable.
   */
  transcriptCapture?: boolean;
  /** Wall-clock budget for the SessionEnd batches; the marker stops at the last batch that landed. */
  transcriptBudgetMs?: number;
  /** Wall-clock budget for the Stop-time turn capture; must fit the Stop hook timeout. */
  stopBudgetMs?: number;
  /** Claude Code config dir used to locate a transcript when the hook payload lacks `transcript_path`. */
  claudeConfigDir?: string;
  /**
   * Gateway client for transcript batches. A batch is up to 100 messages, so it
   * deserves a longer timeout than the per-turn recall and capture calls; when
   * unset the runtime's client (and its timeout) is used.
   */
  transcriptClient?: MemoryClient;
  log?: (message: string) => void;
}

const DEFAULT_TRANSCRIPT_BUDGET_MS = 25_000;
const DEFAULT_STOP_BUDGET_MS = 3_500;

function transcriptCaptureEnabled(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  const value = (process.env.TDAI_CLAUDE_CODE_TRANSCRIPT_CAPTURE ?? "").trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false");
}

function budgetMs(option: number | undefined, envName: string, fallback: number): number {
  if (option !== undefined) return option;
  const parsed = Number(process.env[envName]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface TranscriptDeltaInput {
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  /** Wall-clock budget; batches beyond it wait for the next Stop or SessionEnd. */
  budgetMs: number;
  /** Texts the Gateway sees as the turn's prompt and reply; default to the batch's own first user / last assistant message. */
  userContent?: string;
  assistantContent?: string;
}

type TranscriptDeltaOutcome = "no-transcript" | "nothing-new" | "partial" | "complete";

export class ClaudeCodePlatformAdapter implements PlatformAdapter<ClaudeCodeHookHandler> {
  readonly platform = "claude-code";

  constructor(private readonly options: ClaudeCodePlatformAdapterOptions = {}) {}

  create(runtime: AdapterRuntime): ClaudeCodeHookHandler {
    const state = new ClaudeCodeSessionState(this.options.stateDir);
    const log = this.options.log ?? ((message: string) => process.stderr.write(`[claude-code] ${message}\n`));

    /**
     * Send the transcript delta since the marker as L0 batches. Fail-open: a batch
     * that does not land leaves the marker where it was, so the next Stop or
     * SessionEnd retries from there. Turns the plain Stop path already captured
     * (no transcript available at the time) contribute only their tool traffic.
     */
    const sendTranscriptDelta = async (delta: TranscriptDeltaInput): Promise<TranscriptDeltaOutcome> => {
      const transcriptPath = await resolveTranscriptPath({
        transcriptPath: delta.transcriptPath,
        cwd: delta.cwd,
        sessionId: delta.sessionId,
        claudeConfigDir: this.options.claudeConfigDir,
      });
      if (!transcriptPath) return "no-transcript";

      const entries = sliceAfter(await readTranscriptEntries(transcriptPath), await state.getTranscriptMarker(delta.sessionId));
      if (entries.length === 0) return "nothing-new";

      const capturedPromptIds = new Set<string>();
      for (const promptId of promptIdsIn(entries)) {
        if (await state.isCaptured(delta.sessionId, promptId)) capturedPromptIds.add(promptId);
      }

      const messages = normalizeTranscript(entries, { sessionId: delta.sessionId, capturedPromptIds });
      const lastEntryUuid = entries[entries.length - 1].uuid;
      if (messages.length === 0) {
        // Nothing new worth sending (for example only captured turns): advance the marker anyway.
        await state.setTranscriptMarker(delta.sessionId, lastEntryUuid);
        return "nothing-new";
      }

      const deadline = Date.now() + delta.budgetMs;
      const sessionKey = claudeCodeSessionKey(delta.sessionId);
      const batches = splitBatches(messages);
      for (const [index, batch] of batches.entries()) {
        if (Date.now() > deadline) {
          log(`transcript capture stopped at budget: ${batches.length - index} batch(es) left for ${sessionKey}`);
          return "partial";
        }
        const last = batch[batch.length - 1];
        const request = {
          userContent: delta.userContent ?? batch.find((message) => message.role === "user")?.content ?? "(transcript delta)",
          assistantContent: delta.assistantContent
            ?? [...batch].reverse().find((message) => message.role === "assistant")?.content
            ?? "(transcript delta)",
          sessionKey,
          sessionId: delta.sessionId,
          messages: batch.map(({ sourceUuid: _sourceUuid, ...message }) => message),
        };
        const result = this.options.transcriptClient
          ? await this.options.transcriptClient.capture(request).catch((error: unknown) => {
            log(`transcript capture failed open: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          })
          : await runtime.capture({ operationId: `transcript:${last.sourceUuid}`, ...request });
        if (!result) return "partial";
        // The marker is the last transcript entry this batch drew from. The final
        // batch advances it to the end of the delta so entries that produced no
        // message (thinking only, images) are not re-read next time.
        await state.setTranscriptMarker(delta.sessionId, index === batches.length - 1 ? lastEntryUuid : last.sourceUuid);
      }
      return "complete";
    };

    const transcriptEnabled = transcriptCaptureEnabled(this.options.transcriptCapture);

    return async (input) => {
      if (input.hook_event_name === "UserPromptSubmit") {
        if (input.prompt_id) await state.savePrompt(input.session_id, input.prompt_id, input.prompt);
        else await state.saveLatestPrompt(input.session_id, input.prompt);

        const result = await runtime.recall({
          query: input.prompt,
          sessionKey: claudeCodeSessionKey(input.session_id),
        });
        if (!result?.context) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `<relevant-memories>\n${result.context}\n</relevant-memories>`,
          },
        };
      }

      if (input.hook_event_name === "SessionEnd") {
        if (transcriptEnabled) {
          try {
            await sendTranscriptDelta({
              sessionId: input.session_id,
              cwd: input.cwd,
              transcriptPath: input.transcript_path,
              budgetMs: budgetMs(this.options.transcriptBudgetMs, "TDAI_CLAUDE_CODE_TRANSCRIPT_BUDGET_MS", DEFAULT_TRANSCRIPT_BUDGET_MS),
            });
          } catch (error) {
            log(`transcript capture failed open: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        await runtime.endSession({
          operationId: input.session_id,
          sessionKey: claudeCodeSessionKey(input.session_id),
        });
        return {};
      }

      if (
        input.stop_hook_active
        || !input.last_assistant_message?.trim()
        || (input.background_tasks?.length ?? 0) > 0
        || (input.session_crons?.length ?? 0) > 0
      ) return {};

      const promptRecord = input.prompt_id
        ? await state.getPromptRecord(input.session_id, input.prompt_id)
        : await state.getLatestPromptRecord(input.session_id);
      if (!promptRecord) return {};
      const promptId = promptRecord.promptId;
      if (!await state.beginCapture(input.session_id, promptId)) return {};

      // With a transcript at hand the whole turn goes as one capture: prompt, tool
      // calls, tool results, intermediate text, final message. Per-turn sending keeps
      // each Stop small and leaves SessionEnd only the remainder. A turn whose delta
      // did not fully land stays unclaimed so SessionEnd sends the rest.
      if (transcriptEnabled) {
        let outcome: TranscriptDeltaOutcome = "no-transcript";
        try {
          outcome = await sendTranscriptDelta({
            sessionId: input.session_id,
            cwd: input.cwd,
            transcriptPath: input.transcript_path,
            budgetMs: budgetMs(this.options.stopBudgetMs, "TDAI_CLAUDE_CODE_STOP_BUDGET_MS", DEFAULT_STOP_BUDGET_MS),
            userContent: promptRecord.prompt,
            assistantContent: input.last_assistant_message,
          });
        } catch (error) {
          log(`transcript capture failed open: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (outcome === "complete" || outcome === "nothing-new") {
          // "nothing-new" means an earlier send already covered this turn.
          await state.markCaptured(input.session_id, promptId);
          return {};
        }
        if (outcome === "partial") {
          await state.releaseCapture(input.session_id, promptId);
          return {};
        }
        // no transcript: fall through to the prompt + final message capture
      }

      const result = await runtime.capture({
        operationId: promptId,
        userContent: promptRecord.prompt,
        assistantContent: input.last_assistant_message,
        sessionKey: claudeCodeSessionKey(input.session_id),
        sessionId: input.session_id,
        messages: [
          {
            id: `claude-code:${input.session_id}:${promptId}:user`,
            role: "user",
            content: promptRecord.prompt,
          },
          {
            id: `claude-code:${input.session_id}:${promptId}:assistant`,
            role: "assistant",
            content: input.last_assistant_message,
          },
        ],
      });
      if (result) await state.markCaptured(input.session_id, promptId);
      else await state.releaseCapture(input.session_id, promptId);
      return {};
    };
  }
}