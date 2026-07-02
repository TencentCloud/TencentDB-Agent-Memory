import * as z from "zod/v4";

const nonEmptyString = z.string().trim().min(1);
const optionalNonEmptyString = z.string().trim().min(1).optional();
const limitSchema = z.number().int().optional();

export const recallInputSchema = z.object({
  query: nonEmptyString,
  session_key: nonEmptyString,
  user_id: optionalNonEmptyString,
});

export const captureInputSchema = z.object({
  user_content: nonEmptyString,
  assistant_content: nonEmptyString,
  session_key: nonEmptyString,
  session_id: optionalNonEmptyString,
  user_id: optionalNonEmptyString,
  messages: z.array(z.unknown()).optional(),
});

export const memorySearchInputSchema = z.object({
  query: nonEmptyString,
  limit: limitSchema,
  type: z.enum(["persona", "episodic", "instruction"]).optional(),
  scene: optionalNonEmptyString,
});

export const conversationSearchInputSchema = z.object({
  query: nonEmptyString,
  limit: limitSchema,
  session_key: optionalNonEmptyString,
});

export const sessionEndInputSchema = z.object({
  session_key: nonEmptyString,
  user_id: optionalNonEmptyString,
});

export type RecallToolInput = z.infer<typeof recallInputSchema>;
export type CaptureToolInput = z.infer<typeof captureInputSchema>;
export type MemorySearchToolInput = z.infer<typeof memorySearchInputSchema>;
export type ConversationSearchToolInput = z.infer<typeof conversationSearchInputSchema>;
export type SessionEndToolInput = z.infer<typeof sessionEndInputSchema>;

export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 5;
  if (limit < 1) return 1;
  if (limit > 20) return 20;
  return limit;
}
