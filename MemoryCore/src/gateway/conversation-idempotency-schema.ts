import { z } from "zod";

/** Opaque client retry token shared by the v2 and Skill conversation-add APIs. */
export const conversationIdempotencyKeySchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .optional();
