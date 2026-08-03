/**
 * L1 LLM call + response parsing.
 * Split from l1-extractor.ts. Typed parseFailed distinguishes a
 * malformed LLM response from a legitimately-empty extraction, enabling
 * the retry path in extractL1Memories.
 */
import { EXTRACT_MEMORIES_SYSTEM_PROMPT, formatExtractionPrompt } from "../prompts/l1-extraction.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { sanitizeJsonForParse } from "../../utils/sanitize.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { LLMRunner, Logger } from "../types.js";
import type { SceneSegment } from "./l1-extraction-types.js";

const TAG = "[memory-tdai][l1-extractor]";

export interface LlmExtractionOutcome {
  scenes: SceneSegment[];
  /** True when the LLM response could not be parsed as a scene array. */
  parseFailed: boolean;
}

/**
 * Call LLM to extract scene-segmented memories from conversation messages.
 */
export async function callLlmExtraction(params: {
  newMessages: ConversationMessage[];
  backgroundMessages: ConversationMessage[];
  previousSceneName?: string;
  config: unknown;
  logger?: Logger;
  model?: string;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  llmRunner?: LLMRunner;
}): Promise<LlmExtractionOutcome> {
  const { newMessages, backgroundMessages, previousSceneName, config, logger, model, llmRunner } = params;

  const userPrompt = formatExtractionPrompt({
    newMessages,
    backgroundMessages,
    previousSceneName,
  });

  logger?.debug?.(
    `${TAG} [l1-debug] ENTRY taskId=l1-extraction, newMsgs=${newMessages.length}, bgMsgs=${backgroundMessages.length}, userPromptLen=${userPrompt.length}, sysPromptLen=${EXTRACT_MEMORIES_SYSTEM_PROMPT.length}, model=${model ?? "(default)"}, previousSceneName=${previousSceneName ? JSON.stringify(previousSceneName) : "(none)"}, runnerKind=${llmRunner ? "llmRunner" : "CleanContextRunner"}`,
  );

  let result: string;

  if (llmRunner) {
    result = await llmRunner.run({
      prompt: userPrompt,
      systemPrompt: EXTRACT_MEMORIES_SYSTEM_PROMPT,
      taskId: "l1-extraction",
      timeoutMs: 180_000,
    });
  } else {
    const runner = new CleanContextRunner({
      config,
      modelRef: model,
      enableTools: false,
      logger,
    });

    result = await runner.run({
      prompt: userPrompt,
      systemPrompt: EXTRACT_MEMORIES_SYSTEM_PROMPT,
      taskId: "l1-extraction",
      timeoutMs: 180_000,
    });
  }

  return parseExtractionResult(result, logger);
}

/**
 * Parse the LLM's JSON response into SceneSegment array.
 * Expected format: [{scene_name, message_ids, memories: [...]}]
 */
export function parseExtractionResult(raw: string, logger?: Logger): LlmExtractionOutcome {
  try {
    // Strip markdown code block wrappers if present
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Try to extract JSON array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      logger?.warn?.(`${TAG} No JSON array found in extraction response`);
      // [l1-debug] NO_JSON — dump the full raw so we can see what the LLM actually said
      const rawPreview = raw.slice(0, 2048);
      logger?.warn?.(
        `${TAG} [l1-debug] NO_JSON taskId=l1-extraction, rawLen=${raw.length}, cleanedLen=${cleaned.length}, rawFull=${JSON.stringify(rawPreview)}${raw.length > 2048 ? `…(+${raw.length - 2048})` : ""}`,
      );
      return { scenes: [], parseFailed: true };
    }

    // Sanitize control characters inside JSON string literals that LLM may produce
    const sanitized = sanitizeJsonForParse(arrayMatch[0]);
    const parsed = JSON.parse(sanitized) as unknown[];

    if (!Array.isArray(parsed)) {
      logger?.warn?.(`${TAG} Extraction response is not an array`);
      return { scenes: [], parseFailed: true };
    }

    const scenes: SceneSegment[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const s = item as Record<string, unknown>;

      scenes.push({
        scene_name: typeof s.scene_name === "string" ? s.scene_name : "未知情境",
        message_ids: Array.isArray(s.message_ids) ? s.message_ids.map(String) : [],
        memories: Array.isArray(s.memories)
          ? (s.memories as Array<Record<string, unknown>>)
              .filter((m) => m && typeof m === "object" && typeof m.content === "string" && (m.content as string).length > 0)
              .map((m) => ({
                content: String(m.content),
                type: String(m.type ?? "episodic"),
                scope: String(m.scope ?? "project"),
                priority: typeof m.priority === "number" ? m.priority : 50,
                source_message_ids: Array.isArray(m.source_message_ids) ? m.source_message_ids.map(String) : [],
                metadata: (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>,
              }))
          : [],
      });
    }

    return { scenes, parseFailed: false };
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to parse extraction result: ${err instanceof Error ? err.message : String(err)}`);
    return { scenes: [], parseFailed: true };
  }
}
