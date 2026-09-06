import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DeliveryStore } from "../src/state.js";
import type { CapturedTurn } from "../src/types.js";

const turn: CapturedTurn = {
  key: "a".repeat(64), sessionId: "s1", sourceId: "a1", user: "q", assistant: "a",
  capturedAtMs: 1, skillMessages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
};

describe("durable delivery state", () => {
  it("persists independent L0 and Skill progress across store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-state-"));
    const first = new DeliveryStore(dir);
    await first.begin(turn, true);
    await first.mark(turn.key, "l0");
    const pending = await new DeliveryStore(dir).pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ l0: true, skill: false });
    await new DeliveryStore(dir).mark(turn.key, "skill");
    expect(await new DeliveryStore(dir).pending()).toEqual([]);
    const raw = await readFile(join(dir, "delivery-v1", `${turn.key}.json`), "utf8");
    expect(raw).not.toContain('"user":"q"');
  });

  it("treats Skill as complete when that pipeline is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-state-"));
    const created = await new DeliveryStore(dir).begin(turn, false);
    expect(created.skill).toBe(true);
  });

  it("immediately recovers a claim left by a crashed process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdai-opencode-state-"));
    const records = join(dir, "delivery-v1");
    await mkdir(records, { recursive: true });
    await writeFile(join(records, `${turn.key}.claim`), JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-owner",
      createdAtMs: Date.now(),
    }));
    const operation = vi.fn();
    expect(await new DeliveryStore(dir).claim(turn.key, operation)).toBe(true);
    expect(operation).toHaveBeenCalledOnce();
  });
});
