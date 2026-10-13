/**
 * L1.5 Response Parser — extracts task judgment from LLM output.
 */
import { extractJson } from "./json-utils.js";
import type { TaskJudgment } from "../../types.js";

interface RawL15Response {
  taskCompleted?: boolean | null;
  isContinuation?: boolean | null;
  isLongTask?: boolean | null;
  continuationMmdFile?: string | null;
  newTaskLabel?: string | null;
}

/**
 * Parse L1.5 LLM response into TaskJudgment.
 * Returns null if the response is completely unparseable or all-null (backend unavailable).
 */
export function parseL15Response(raw: string): TaskJudgment | null {
  const parsed = extractJson<RawL15Response>(raw);
  if (!parsed || typeof parsed !== "object") return null;

  // All-null check (mirrors normalizeJudgment logic)
  if (parsed.taskCompleted == null && parsed.isContinuation == null && parsed.isLongTask == null) {
    return null;
  }

  return {
    taskCompleted: toBool(parsed.taskCompleted),
    isContinuation: toBool(parsed.isContinuation),
    isLongTask: toBool(parsed.isLongTask),
    continuationMmdFile:
      typeof parsed.continuationMmdFile === "string" ? parsed.continuationMmdFile : undefined,
    newTaskLabel:
      typeof parsed.newTaskLabel === "string" ? parsed.newTaskLabel : undefined,
  };
}

/** Match server-mode coercion when the model returns quoted boolean values. */
function toBool(value: unknown): boolean {
  if (typeof value === "string") {
    return value.toLowerCase() !== "false" && value !== "0" && value !== "";
  }
  return Boolean(value);
}
