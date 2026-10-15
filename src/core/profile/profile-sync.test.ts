import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pullProfilesToLocal } from "./profile-sync.js";
import type { IMemoryStore, ProfileRecord } from "../store/types.js";

const tempDirs: string[] = [];

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tdai-profile-sync-"));
  tempDirs.push(dir);
  return dir;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function makeStore(records: ProfileRecord[]): IMemoryStore {
  return {
    pullProfiles: async () => records,
  } as unknown as IMemoryStore;
}

describe("pullProfilesToLocal", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps remote L2 filenames inside scene_blocks", async () => {
    const dataDir = await makeDataDir();
    const content = "remote scene";
    const store = makeStore([
      {
        id: "profile:v1:remote",
        type: "l2",
        filename: "../../escaped.md",
        content,
        contentMd5: md5(content),
        version: 1,
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    ]);

    await pullProfilesToLocal(dataDir, store, {});

    expect(await exists(path.join(dataDir, "escaped.md"))).toBe(false);
    await expect(readFile(path.join(dataDir, "scene_blocks", "escaped.md"), "utf-8")).resolves.toBe(content);
  });
});
