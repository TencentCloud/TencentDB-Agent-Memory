/**
 * Claude Code lifecycle hooks → Memory Gateway v3.
 *
 * | Event            | Action                                                                  |
 * |------------------|-------------------------------------------------------------------------|
 * | UserPromptSubmit | cache the prompt; recall L1 (and persona + scenes on the first prompt); |
 * |                  | return `additionalContext`                                              |
 * | Stop             | capture the finished turn from the transcript (fallback: prompt+reply)  |
 * | SessionEnd       | capture whatever transcript remains unsent                              |
 *
 * Every path fails open: a Gateway problem never blocks Claude Code.
 */

import type { V3MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import type { PluginConfig } from "../config.js";
import { sendPlainTurn, sendTranscriptDelta } from "./capture.js";
import { performRecall } from "./recall.js";
import type { PluginState } from "./state.js";

export interface UserPromptSubmitInput {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  prompt_id?: string;
  cwd?: string;
  prompt: string;
  transcript_path?: string;
}

export interface StopInput {
  hook_event_name: "Stop";
  session_id: string;
  prompt_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
  background_tasks?: unknown[];
  session_crons?: unknown[];
  transcript_path?: string;
}

export interface SessionEndInput {
  hook_event_name: "SessionEnd";
  session_id: string;
  cwd?: string;
  reason?: string;
  transcript_path?: string;
}

export type HookInput = UserPromptSubmitInput | StopInput | SessionEndInput;
export type HookOutput = Record<string, unknown>;

export interface HookDeps {
  config: PluginConfig;
  state: PluginState;
  /** Client with the short recall timeout. */
  recallClient: V3MemoryClient;
  /** Client with the longer capture timeout. */
  captureClient: V3MemoryClient;
  log: (message: string) => void;
  claudeConfigDir?: string;
}

const SESSION_CONTEXT_FLAG = "session-context-sent";

export async function handleHook(input: HookInput, deps: HookDeps): Promise<HookOutput> {
  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      return onUserPromptSubmit(input, deps);
    case "Stop":
      return onStop(input, deps);
    case "SessionEnd":
      return onSessionEnd(input, deps);
    default:
      return {};
  }
}

async function onUserPromptSubmit(input: UserPromptSubmitInput, deps: HookDeps): Promise<HookOutput> {
  const { config, state } = deps;
  if (input.prompt_id) await state.savePrompt(input.session_id, input.prompt_id, input.prompt);
  else await state.saveLatestPrompt(input.session_id, input.prompt);

  const includeSessionContext = !(await state.hasSessionFlag(input.session_id, SESSION_CONTEXT_FLAG));
  let result;
  try {
    result = await performRecall(deps.recallClient, {
      query: input.prompt,
      maxResults: config.recallMaxResults,
      includePersona: config.recallIncludePersona,
      includeSceneNav: config.recallIncludeSceneNav,
      includeSessionContext,
    });
  } catch (error) {
    deps.log(`recall failed open: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  if (includeSessionContext && !result.allFailed) await state.setSessionFlag(input.session_id, SESSION_CONTEXT_FLAG);
  if (!result.context) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: result.context,
    },
  };
}

async function onStop(input: StopInput, deps: HookDeps): Promise<HookOutput> {
  const { config, state } = deps;
  if (!config.captureEnabled) return {};
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

  const captureDeps = { client: deps.captureClient, state, log: deps.log };
  let outcome: Awaited<ReturnType<typeof sendTranscriptDelta>> = "no-transcript";
  try {
    outcome = await sendTranscriptDelta(captureDeps, {
      sessionId: input.session_id,
      cwd: input.cwd,
      transcriptPath: input.transcript_path,
      budgetMs: config.stopBudgetMs,
      claudeConfigDir: deps.claudeConfigDir,
    });
  } catch (error) {
    deps.log(`transcript capture failed open: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (outcome === "complete" || outcome === "nothing-new") {
    await state.markCaptured(input.session_id, promptId);
    return {};
  }
  if (outcome === "partial") {
    // Unclaimed on purpose: SessionEnd sends the rest of this turn.
    await state.releaseCapture(input.session_id, promptId);
    return {};
  }

  const sent = await sendPlainTurn(captureDeps, {
    sessionId: input.session_id,
    promptId,
    prompt: promptRecord.prompt,
    reply: input.last_assistant_message,
  });
  if (sent) await state.markCaptured(input.session_id, promptId);
  else await state.releaseCapture(input.session_id, promptId);
  return {};
}

async function onSessionEnd(input: SessionEndInput, deps: HookDeps): Promise<HookOutput> {
  const { config, state } = deps;
  if (!config.captureEnabled) return {};
  try {
    await sendTranscriptDelta({ client: deps.captureClient, state, log: deps.log }, {
      sessionId: input.session_id,
      cwd: input.cwd,
      transcriptPath: input.transcript_path,
      budgetMs: config.sessionEndBudgetMs,
      claudeConfigDir: deps.claudeConfigDir,
    });
  } catch (error) {
    deps.log(`transcript capture failed open: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {};
}
