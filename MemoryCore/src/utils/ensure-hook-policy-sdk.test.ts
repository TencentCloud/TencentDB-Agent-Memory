import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensurePluginHookPolicy } from "./ensure-hook-policy.js";

const dirs: string[] = [];
const originalArgv = process.argv;
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
const pluginId = "memory-tencentdb";
type RuntimeConfig = NonNullable<Parameters<typeof ensurePluginHookPolicy>[0]["runtimeConfig"]>;
beforeEach(() => { process.argv = [process.execPath, "openclaw.mjs", "gateway"]; });
afterEach(() => {
  vi.restoreAllMocks();
  process.argv = originalArgv;
  if (originalConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
  else process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(raw?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-sdk-test-"));
  dirs.push(dir);
  const file = path.join(dir, "openclaw.json");
  const config = { gateway: { mode: "local" }, plugins: { entries: {
    other: { enabled: false }, [pluginId]: { enabled: true, hooks: { otherPolicy: "preserve" }, config: { capture: true } },
  } } };
  const original = raw ?? JSON.stringify(config, null, 2) + "\n";
  fs.writeFileSync(file, original);
  process.env.OPENCLAW_CONFIG_PATH = file;
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    file, config, original, logger,
    read: () => fs.readFileSync(file, "utf8"),
    run(runtimeConfig?: RuntimeConfig, rootConfig?: unknown) {
      ensurePluginHookPolicy({ logger, runtimeConfig, rootConfig });
    },
    expectPatched() {
      const expected = structuredClone(config);
      Object.assign(expected.plugins.entries[pluginId].hooks, { allowConversationAccess: true });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(expected);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw gateway restart"));
      expect(logger.info.mock.calls.flat().join("\n")).not.toContain("gateway will restart automatically");
    },
  };
}

// Drain the asynchronous SDK completion/fallback without relying on sleeps.
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("hook policy SDK failure recovery", () => {
  it("falls back when the SDK throws synchronously, preserving unrelated configuration", async () => {
    const h = fixture();
    expect(() => h.run({ mutateConfigFile() { throw new Error("unsupported SDK signature"); } })).not.toThrow();
    await settled();
    h.expectPatched();
  });

  it("falls back when an SDK promise rejects", async () => {
    const h = fixture();
    h.run({ mutateConfigFile: async () => { throw new Error("SDK unavailable"); } });
    await settled();
    h.expectPatched();
  });

  it.each([undefined, null, true])("falls back on an incompatible SDK return value (%j)", async (value) => {
    const h = fixture();
    const runtime = { mutateConfigFile: () => value } as unknown as RuntimeConfig;
    expect(() => h.run(runtime)).not.toThrow();
    await settled();
    h.expectPatched();
  });

  it("falls back if the host exposes a non-callable SDK member", async () => {
    const h = fixture();
    expect(() => h.run({ mutateConfigFile: {} } as unknown as RuntimeConfig)).not.toThrow();
    await settled();
    h.expectPatched();
  });

  it("does not rewrite the configuration on repeated fallback calls", async () => {
    const h = fixture();
    const writes = vi.spyOn(fs, "writeFileSync");
    const runtime = { mutateConfigFile() { throw new Error("old SDK"); } };
    for (let i = 0; i < 3; i++) { h.run(runtime); await settled(); }
    h.expectPatched();
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("leaves a rejected manual write intact and reports the need for manual configuration", async () => {
    const h = fixture();
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("read-only config"); });
    h.run({ mutateConfigFile: async () => { throw new Error("SDK unavailable"); } });
    await settled();
    expect(h.read()).toBe(h.original);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to write"));
    expect(h.logger.info.mock.calls.flat().join("\n")).not.toContain("Patched via SDK");
  });
});

describe("hook policy fallback boundaries", () => {
  it.each(["null", "[]", "true", "42", '"config"', "{broken"])('preserves invalid config root %s after SDK failure', async (raw) => {
    const h = fixture(raw);
    expect(() => h.run({ mutateConfigFile() { throw new Error("SDK unavailable"); } })).not.toThrow();
    await settled();
    expect(h.read()).toBe(raw);
    expect(h.logger.warn.mock.calls.flat().join("\n")).toContain("manually");
  });

  it("keeps $include configuration unchanged and provides a manual remedy", async () => {
    const h = fixture('{"$include": "./shared.json"}');
    h.run({ mutateConfigFile: async () => { throw new Error("SDK unavailable"); } });
    await settled();
    expect(h.read()).toBe(h.original);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Config uses $include"));
  });

  it("uses a successful SDK mutation without a manual write and preserves its receiver", async () => {
    const h = fixture();
    const draft = structuredClone(h.config);
    const runtime = { async mutateConfigFile(params: { mutate: (draft: unknown) => void; afterWrite: { mode: string } }) {
      expect(this).toBe(runtime);
      expect(params.afterWrite.mode).toBe("restart");
      params.mutate(draft);
    } };
    h.run(runtime);
    await settled();
    expect((draft.plugins.entries[pluginId].hooks as Record<string, unknown>).allowConversationAccess).toBe(true);
    expect(h.read()).toBe(h.original);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("Patched via SDK"));
  });

  it("does not invoke the SDK when the loaded policy is already active", async () => {
    const h = fixture();
    const mutateConfigFile = vi.fn();
    h.run({ mutateConfigFile }, { plugins: { entries: { [pluginId]: { hooks: { allowConversationAccess: true } } } } });
    await settled();
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(h.read()).toBe(h.original);
  });

  it("does not modify configuration during non-gateway commands", async () => {
    const h = fixture();
    process.argv = [process.execPath, "openclaw.mjs", "plugins", "list"];
    const mutateConfigFile = vi.fn();
    h.run({ mutateConfigFile });
    await settled();
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(h.read()).toBe(h.original);
  });
});
