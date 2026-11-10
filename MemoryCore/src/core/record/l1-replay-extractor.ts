import { z } from "zod";
import type { LLMRunner } from "../types.js";
import { formatExtractionPrompt, getExtractMemoriesSystemPrompt } from "../prompts/l1-extraction.js";
import { validateCandidates, type ReplaySource } from "./l1-replay.js";

/** Unlike best-effort online extraction, malformed output must remain retryable. */
export async function extractReplayCandidates(
  runner: LLMRunner, sources: ReplaySource[], mode: "chat" | "code" = "chat",
) {
  const response = await runner.run({
    taskId: "l1-replay", enableTools: false,
    systemPrompt: getExtractMemoriesSystemPrompt(mode),
    prompt: formatExtractionPrompt({ newMessages: sources.map((source) => ({
      id: source.record_id, role: source.role === "assistant" ? "assistant" : "user",
      content: source.message_text, timestamp: Date.parse(source.recorded_at),
    })) }),
  });
  const text = response.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  const scenes = z.array(z.object({
    scene_name: z.string().trim().min(1), message_ids: z.array(z.string()),
    memories: z.array(z.record(z.string(), z.unknown())),
  })).parse(JSON.parse(text));
  const ids = new Set(sources.map((source) => source.record_id));
  if (scenes.some((scene) => scene.message_ids.some((id) => !ids.has(id)))) {
    throw new Error("Extraction scene contains an unknown source ID");
  }
  return validateCandidates(scenes.flatMap((scene) => scene.memories.map((memory) => ({
    ...memory, scene_name: scene.scene_name,
  }))), sources);
}
