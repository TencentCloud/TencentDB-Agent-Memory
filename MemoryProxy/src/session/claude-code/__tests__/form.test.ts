import { describe, expect, it } from "vitest";
import { ASSET_CONFIRM_YES, buildFormResponse, TOOL_NAME } from "../form.js";

async function readSse(response: Response): Promise<string> {
  return await response.text();
}

function parseSseEvents(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const chunks = raw.split("\n\n").map((c) => c.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    let event = "";
    let dataRaw = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      if (line.startsWith("data: ")) dataRaw = line.slice("data: ".length);
    }
    if (!event || !dataRaw) continue;
    events.push({ event, data: JSON.parse(dataRaw) as Record<string, unknown> });
  }
  return events;
}

describe("claude-code session-init form SSE (#990)", () => {
  it("emits a non-empty thinking block before AskUserQuestion tool_use", async () => {
    const response = buildFormResponse({
      teams: [],
      stage: "asset_confirm",
      modelId: "deepseek-v4-flash",
    });

    const sse = await readSse(response);
    const events = parseSseEvents(sse);

    const thinkingStart = events.find((e) => {
      if (e.event !== "content_block_start") return false;
      const block = e.data.content_block as Record<string, unknown> | undefined;
      return block?.type === "thinking";
    });
    expect(thinkingStart, "session-init form must open a thinking content block").toBeTruthy();
    expect(thinkingStart?.data.index).toBe(0);

    const thinkingDelta = events.find((e) => {
      if (e.event !== "content_block_delta") return false;
      const delta = e.data.delta as Record<string, unknown> | undefined;
      return delta?.type === "thinking_delta";
    });
    expect(thinkingDelta).toBeTruthy();
    const thinkingText = (thinkingDelta?.data.delta as { thinking?: string } | undefined)?.thinking ?? "";
    expect(thinkingText.length).toBeGreaterThan(0);

    const toolStart = events.find((e) => {
      if (e.event !== "content_block_start") return false;
      const block = e.data.content_block as Record<string, unknown> | undefined;
      return block?.type === "tool_use";
    });
    expect(toolStart).toBeTruthy();
    expect(toolStart?.data.index).toBe(1);
    const toolBlock = toolStart?.data.content_block as { name?: string };
    expect(toolBlock.name).toBe(TOOL_NAME);

    expect(sse).toContain(ASSET_CONFIRM_YES);
  });
});
