import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  failRename: false,
  target: "",
  partial: '{"version":"partial"',
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (
      file: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) => {
      if (fault.failRename && String(file) === fault.target) {
        await actual.writeFile(file, fault.partial, "utf8");
        throw new Error("simulated interruption before durable replacement");
      }
      return actual.writeFile(file, data, options);
    },
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      if (fault.failRename) {
        throw new Error("simulated interruption before atomic rename");
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

import { createStorageContext, writeStateFile } from "../storage.js";

const tempDirs: string[] = [];

afterEach(async () => {
  fault.failRename = false;
  fault.target = "";
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("offload atomic state writes", () => {
  it("preserves the last durable state when replacement is interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "offload-atomic-"));
    tempDirs.push(root);
    const ctx = createStorageContext(root, "agent-test", "session-test");
    const oldState = { version: "old", durable: true };
    await mkdir(dirname(ctx.stateFile), { recursive: true });
    await writeFile(ctx.stateFile, JSON.stringify(oldState), "utf8");

    fault.target = ctx.stateFile;
    fault.failRename = true;

    await expect(writeStateFile(ctx, { version: "new", durable: false }))
      .rejects.toThrow("simulated interruption");

    fault.failRename = false;
    expect(JSON.parse(await readFile(ctx.stateFile, "utf8"))).toEqual(oldState);

    const newState = { version: "new", durable: true };
    await writeStateFile(ctx, newState);
    expect(JSON.parse(await readFile(ctx.stateFile, "utf8"))).toEqual(newState);
    expect((await readdir(dirname(ctx.stateFile))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
