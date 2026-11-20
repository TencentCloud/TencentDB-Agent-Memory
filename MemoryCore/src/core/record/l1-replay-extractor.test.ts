import { describe, expect, it, vi } from "vitest";
import { extractReplayCandidates } from "./l1-replay-extractor.js";
import type { ReplaySource } from "./l1-replay.js";
import type { LLMRunParams } from "../types.js";

const rows = [{ record_id: "original-id", message_text: "Atlas freezes until Friday",
  role: "user", recorded_at: "2026-10-01T00:00:00.000Z", timestamp: 0 } as ReplaySource];
const scene = { scene_name: "Atlas", message_ids: ["original-id"], memories: [{
  content: "Atlas freezes until Friday", type: "work_fact", priority: 80,
  source_message_ids: ["original-id"], metadata: {},
}] };

describe("strict replay extraction", () => {
  it("uses original IDs and recorded time, and accepts the normal scene format", async () => {
    const run = vi.fn(async (_params: LLMRunParams) => JSON.stringify([scene]));
    expect(await extractReplayCandidates({ run }, rows, "code")).toMatchObject([
      { scene_name: "Atlas", source_message_ids: ["original-id"] },
    ]);
    expect(run.mock.calls[0][0]).toMatchObject({ enableTools: false });
    expect(run.mock.calls[0][0].prompt).toContain("[original-id] [user] [2026-10-01T00:00:00.000Z]");
  });
  it.each(["[]", JSON.stringify([{ ...scene, memories: [] }])])("accepts a successful empty result: %s", async (response) => {
    expect(await extractReplayCandidates({ run: async () => response }, rows)).toEqual([]);
  });
  it.each(["", "provider refused", "{", "{}", "null", '[{"scene_name":"Atlas"}]',
    JSON.stringify([{ ...scene, message_ids: ["another-tenant"] }]),
    JSON.stringify([{ ...scene, memories: [{ ...scene.memories[0], source_message_ids: ["foreign"] }] }]),
    JSON.stringify([{ ...scene, memories: [{ ...scene.memories[0], type: "made-up" }] }]),
  ])("fails the batch on invalid or foreign output: %s", async (response) => {
    await expect(extractReplayCandidates({ run: async () => response }, rows)).rejects.toThrow();
  });
  it("propagates model failures", async () => {
    await expect(extractReplayCandidates({ run: async () => { throw new Error("offline"); } }, rows)).rejects.toThrow("offline");
  });
});
