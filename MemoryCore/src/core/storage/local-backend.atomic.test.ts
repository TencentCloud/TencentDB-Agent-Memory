import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const writeFailure = vi.hoisted(() => ({ failNextWrite: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (
      path: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) => {
      if (writeFailure.failNextWrite) {
        writeFailure.failNextWrite = false;
        await actual.writeFile(path, String(data).slice(0, 4), options);
        throw new Error("simulated process interruption");
      }
      return actual.writeFile(path, data, options);
    },
  };
});

import { LocalStorageBackend } from "./local-backend.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("LocalStorageBackend atomic replacement", () => {
  it("keeps the previous object when an overwrite is interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "tdai-local-storage-"));
    roots.push(root);
    const backend = new LocalStorageBackend(root);
    await backend.putObject("state.json", "old-valid");

    writeFailure.failNextWrite = true;
    await expect(backend.putObject("state.json", "new-value")).rejects.toThrow(
      "simulated process interruption",
    );

    const current = await backend.getObject("state.json");
    expect(current?.content.toString()).toBe("old-valid");

    await backend.putObject("state.json", "new-value");
    const replaced = await backend.getObject("state.json");
    expect(replaced?.content.toString()).toBe("new-value");
  });
});
