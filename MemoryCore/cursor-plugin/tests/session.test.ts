import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionMarker,
  isTopLevelSession,
  markTopLevelSession,
  sessionMarkerPath,
} from "../src/session.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })
  ));
});

describe("Cursor session marker", () => {
  // 会话 ID 不得进入路径；marker 也不保存正文或原始 ID。
  it("marks and clears top-level sessions with hashed markers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-session-"));
    tempDirs.push(root);

    await markTopLevelSession(root, "../敏感会话");

    const marker = sessionMarkerPath(root, "../敏感会话");
    expect(marker).toMatch(/sessions\/[0-9a-f]{64}\.top-level$/);
    expect(await isTopLevelSession(root, "../敏感会话")).toBe(true);

    await clearSessionMarker(root, "../敏感会话");

    expect(await isTopLevelSession(root, "../敏感会话")).toBe(false);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
