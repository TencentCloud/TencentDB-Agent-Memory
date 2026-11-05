import fs from "node:fs";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensurePluginHookPolicy } from "./ensure-hook-policy.js";

const tempDirs: string[] = [];
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensurePluginHookPolicy manual persistence", () => {
  it("preserves the previous config when replacement is interrupted", () => {
    const root = mkdtempSync(join(tmpdir(), "tdai-hook-policy-"));
    tempDirs.push(root);
    const configPath = join(root, "openclaw.json");
    const originalConfig = {
      gateway: { mode: "local" },
      plugins: { entries: { existing: { enabled: true } } },
    };
    writeFileSync(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`, "utf8");
    process.env.OPENCLAW_CONFIG_PATH = configPath;

    const realWriteFileSync = fs.writeFileSync.bind(fs);
    let interrupted = false;
    const writeSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation(((
        file: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options?: fs.WriteFileOptions,
      ) => {
        if (!interrupted) {
          interrupted = true;
          realWriteFileSync(file, String(data).slice(0, 12), options);
          throw new Error("simulated process interruption");
        }
        return realWriteFileSync(file, data, options);
      }) as typeof fs.writeFileSync);

    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    ensurePluginHookPolicy({ rootConfig: {}, logger });

    expect(writeSpy).toHaveBeenCalled();
    const preservedRaw = readFileSync(configPath, "utf8");
    expect(JSON.parse(preservedRaw)).toEqual(originalConfig);
    expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual([]);

    ensurePluginHookPolicy({ rootConfig: {}, logger });
    const repaired = JSON.parse(readFileSync(configPath, "utf8"));
    expect(repaired.gateway).toEqual(originalConfig.gateway);
    expect(repaired.plugins.entries.existing).toEqual({ enabled: true });
    expect(
      repaired.plugins.entries["memory-tencentdb"].hooks.allowConversationAccess,
    ).toBe(true);
    expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
