import { describe, expect, it, vi } from "vitest";
import { TcvdbClient } from "./tcvdb-client.js";

describe("TcvdbClient.update", () => {
  it("disables transport retries for non-idempotent conditional updates", async () => {
    const client = new TcvdbClient({
      url: "https://example.invalid",
      username: "user",
      apiKey: "key",
      database: "test",
      timeout: 1000,
    });
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValue({ affectedCount: 1 });

    const affected = await client.update(
      "test_l1_memories",
      { documentIds: ["memory-1"], filter: "version = 2" },
      { text: "edited content", version: 3 },
    );

    expect(affected).toBe(1);
    expect(request).toHaveBeenCalledWith(
      "/document/update",
      {
        database: "test",
        collection: "test_l1_memories",
        query: { documentIds: ["memory-1"], filter: "version = 2" },
        update: { text: "edited content", version: 3 },
      },
      { maxRetries: 0 },
    );
  });
});
