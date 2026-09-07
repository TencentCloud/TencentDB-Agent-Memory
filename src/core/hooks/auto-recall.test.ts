import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../config.js";
import {
  MEMORY_TOOLS_GUIDE,
  composeStableParts,
  performAutoRecall,
} from "./auto-recall.js";

const PERSONA = "# Persona\n用户是一名后端工程师，偏好简洁中文回复。";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-120-recall-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("composeStableParts", () => {
  it("reproduces the legacy join byte-for-byte (persona + scene + guide)", () => {
    const persona = "persona-body";
    const scene = "scene-nav-body";
    const legacy = [
      `<user-persona>\n${persona}\n</user-persona>`,
      `<scene-navigation>\n${scene}\n</scene-navigation>`,
      MEMORY_TOOLS_GUIDE,
    ].join("\n\n");
    expect(composeStableParts(persona, scene, false)).toBe(legacy);
    expect(composeStableParts(persona, scene, true)).toBe(legacy);
  });

  it("persona only → persona + guide", () => {
    expect(composeStableParts("p", undefined, false)).toBe(
      `<user-persona>\np\n</user-persona>\n\n${MEMORY_TOOLS_GUIDE}`,
    );
  });

  it("no stable parts but dynamic context exists → guide only (legacy guard)", () => {
    expect(composeStableParts(undefined, undefined, true)).toBe(MEMORY_TOOLS_GUIDE);
  });

  it("nothing at all → undefined", () => {
    expect(composeStableParts(undefined, undefined, false)).toBeUndefined();
  });
});

describe("performAutoRecall (offline, no vector store)", () => {
  it("loads persona into appendSystemContext with no memories → no prependContext", async () => {
    await fs.writeFile(path.join(tmpDir, "persona.md"), PERSONA, "utf-8");
    const cfg = parseConfig({});

    const result = await performAutoRecall({
      userText: "帮我看看这个部署脚本",
      actorId: "default_user",
      sessionKey: "s1",
      cfg,
      pluginDataDir: tmpDir,
    });

    expect(result).toBeDefined();
    expect(result?.prependContext).toBeUndefined();
    expect(result?.appendSystemContext).toContain("<user-persona>");
    expect(result?.appendSystemContext).toContain("后端工程师");
    expect(result?.appendSystemContext).toContain("<memory-tools-guide>");
    // Byte-equality with the extracted composer (persona-only path)
    expect(result?.appendSystemContext).toBe(
      composeStableParts(result?.recalledL3Persona ?? undefined, undefined, false),
    );
  });

  it("returns undefined when there is nothing to inject", async () => {
    const cfg = parseConfig({});
    const result = await performAutoRecall({
      userText: "hello",
      actorId: "default_user",
      sessionKey: "s1",
      cfg,
      pluginDataDir: tmpDir,
    });
    expect(result).toBeUndefined();
  });

  it("skipMemorySearch bypasses the search but still loads persona", async () => {
    await fs.writeFile(path.join(tmpDir, "persona.md"), PERSONA, "utf-8");
    const cfg = parseConfig({});
    const isFtsAvailable = vi.fn(() => false);
    const fakeStore = { isFtsAvailable } as never;

    const skipped = await performAutoRecall({
      userText: "查一下我上周说过什么",
      actorId: "default_user",
      sessionKey: "s1",
      cfg,
      pluginDataDir: tmpDir,
      vectorStore: fakeStore,
      options: { skipMemorySearch: true },
    });
    expect(isFtsAvailable).not.toHaveBeenCalled();
    expect(skipped?.recallStrategy).toBe("skipped");
    expect(skipped?.appendSystemContext).toContain("<user-persona>");
    expect(skipped?.recalledL1Memories).toEqual([]);

    // Control: without the option, the keyword path probes FTS availability
    const searched = await performAutoRecall({
      userText: "查一下我上周说过什么",
      actorId: "default_user",
      sessionKey: "s1",
      cfg,
      pluginDataDir: tmpDir,
      vectorStore: fakeStore,
    });
    expect(isFtsAvailable).toHaveBeenCalled();
    expect(searched?.recallStrategy).not.toBe("skipped");
  });
});
