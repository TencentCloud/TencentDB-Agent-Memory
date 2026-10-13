import { expect, it } from "vitest";
import { createStateBackend } from "../src/core/state/index.js";

it.each(["synthetic-private-selector", "", null])("rejects an unknown state backend without silently creating local state: %s", async type => {
  const config = JSON.parse(JSON.stringify({ type }));
  await expect(createStateBackend(config)).rejects.toThrow("Unsupported state backend");
});
it("rejects unavailable Redis without accessing credentials", async () => {
  await expect(createStateBackend({ type: "redis", get redis(): never { throw new Error("synthetic-private-credential"); } })).rejects.toThrow("Redis state backend is not supported");
});
it("rejects Redis even when configuration is omitted", async () => {
  await expect(createStateBackend({ type: "redis" })).rejects.toThrow("Redis state backend is not supported");
});
it("preserves explicitly selected local state and buffer behavior", async () => {
  const backend = await createStateBackend({ type: "local" });
  try {
    await backend.appendBuffer("synthetic", "session", "payload", "team", "agent");
    expect(await backend.drainBuffer("synthetic", "session", "team", "agent")).toEqual(["payload"]);
  } finally { await backend.destroy(); }
});
