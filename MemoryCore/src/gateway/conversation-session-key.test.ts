import { describe, expect, it } from "vitest";
import { conversationAddRequestSchema } from "./v2-schemas.js";

const messages = [{ role: "user" as const, content: "Remember this." }];

describe("conversation add session identity", () => {
  it("uses the legacy session_key instead of silently writing to the default session", () => {
    const parsed = conversationAddRequestSchema.parse({
      session_key: "legacy-session",
      messages,
    });

    expect(parsed.session_id).toBe("legacy-session");
  });

  it("keeps an explicit session_id when both field names are present", () => {
    const parsed = conversationAddRequestSchema.parse({
      session_id: "canonical-session",
      session_key: "legacy-session",
      messages,
    });

    expect(parsed.session_id).toBe("canonical-session");
  });

  it.each([42, null, ""])("rejects an invalid legacy session_key value %j", (sessionKey) => {
    const parsed = conversationAddRequestSchema.safeParse({
      session_key: sessionKey,
      messages,
    });

    expect(parsed.success).toBe(false);
  });
});
