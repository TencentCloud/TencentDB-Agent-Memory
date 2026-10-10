import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { CheckpointManager } from "./checkpoint.js";

const tempDirs: string[] = [];

async function createCheckpointDir(): Promise<{
  dataDir: string;
  checkpointPath: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "tdai-checkpoint-test-"));
  tempDirs.push(dataDir);
  const checkpointPath = join(
    dataDir,
    ".metadata",
    "recall_checkpoint.json",
  );
  await mkdir(dirname(checkpointPath), { recursive: true });
  return { dataDir, checkpointPath };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("CheckpointManager corruption handling", () => {
  it("initializes defaults when the checkpoint does not exist", async () => {
    const { dataDir } = await createCheckpointDir();
    const checkpoint = await new CheckpointManager(dataDir).read();

    expect(checkpoint.runner_states).toEqual({});
    expect(checkpoint.pipeline_states).toEqual({});
    expect(checkpoint.total_processed).toBe(0);
  });

  it("rejects malformed checkpoint JSON instead of treating it as first run", async () => {
    const { dataDir, checkpointPath } = await createCheckpointDir();
    await writeFile(checkpointPath, '{"runner_states":{"sessionA":', "utf-8");

    const manager = new CheckpointManager(dataDir);

    await expect(manager.read()).rejects.toThrow(/checkpoint/i);
  });

  it("does not overwrite a malformed checkpoint during a later mutation", async () => {
    const { dataDir, checkpointPath } = await createCheckpointDir();
    const malformed = '{"runner_states":{"sessionA":';
    await writeFile(checkpointPath, malformed, "utf-8");

    const manager = new CheckpointManager(dataDir);

    await expect(manager.setPersonaUpdateRequest("manual")).rejects.toThrow(
      /checkpoint/i,
    );
    await expect(readFile(checkpointPath, "utf-8")).resolves.toBe(malformed);
  });
});
