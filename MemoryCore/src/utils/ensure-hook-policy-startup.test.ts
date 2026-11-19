import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temp = new Set<string>();
const cleanup: Array<() => Promise<void> | void> = [];

async function loadPlugin({
  command = ["gateway", "run"],
  version = "2026.4.24",
  metadataOnly = false,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hook-policy-startup-"));
  temp.add(dir);
  const configPath = path.join(dir, "openclaw.json");
  const config = { gateway: { mode: "local" } };
  writeFileSync(configPath, JSON.stringify(config));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("LOG_PATH", dir);
  vi.spyOn(process, "argv", "get").mockReturnValue([
    process.execPath,
    "openclaw.mjs",
    ...command,
  ]);

  let rejectSdk!: (reason: Error) => void;
  const mutateConfigFile = vi.fn(
    () =>
      new Promise<void>((_, reject) => {
        rejectSdk = reject;
      }),
  );
  const services: Array<{
    id: string;
    start: (ctx: { config: unknown }) => Promise<void> | void;
  }> = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const { default: register } = await import("../../index.js");
  const returned = register({
    registrationMode: metadataOnly ? "cli-metadata" : "full",
    pluginConfig: {
      mode: "local",
      recall: { enabled: false },
      capture: { enabled: false },
      embedding: { provider: "none" },
      extraction: { enabled: false },
      offload: { enabled: false },
      report: { enabled: false },
      memoryCleanup: { enabled: false },
      skill: { enabled: false },
    },
    config,
    runtime: {
      version,
      agent: {},
      state: { resolveStateDir: () => dir },
      config: { mutateConfigFile },
    },
    logger,
    registerTool() {},
    registerCli() {},
    registerService(service: (typeof services)[number]) {
      services.push(service);
    },
    on(name: string, handler: () => Promise<void> | void) {
      if (name === "gateway_stop") cleanup.push(handler);
    },
  } as unknown as Parameters<typeof register>[0]);
  return {
    returned,
    config,
    services,
    logger,
    mutateConfigFile,
    rejectSdk: () => rejectSdk(new Error("SDK unavailable")),
    read: () => JSON.parse(readFileSync(configPath, "utf8")),
  };
}

afterEach(async () => {
  try {
    for (const stop of cleanup.splice(0)) await stop();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of temp) rmSync(dir, { recursive: true, force: true });
    temp.clear();
  }
});

describe("OpenClaw Gateway hook policy startup", () => {
  it("waits for asynchronous SDK failure and fallback in the Gateway start task", async () => {
    const h = await loadPlugin();
    expect(h.returned).toBeUndefined();
    expect(h.mutateConfigFile).not.toHaveBeenCalled();
    const service = h.services.find(
      (entry) => entry.id === "memory-tencentdb-hook-policy",
    );
    expect(service).toBeDefined();
    let done = false;
    const started = Promise.resolve(service!.start({ config: h.config })).then(
      () => {
        done = true;
      },
    );
    await Promise.resolve();
    expect(h.mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    expect(h.read()).toEqual(h.config);

    h.rejectSdk();
    await started;
    expect(h.read()).toMatchObject({
      ...h.config,
      plugins: {
        entries: {
          "memory-tencentdb": { hooks: { allowConversationAccess: true } },
        },
      },
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Gateway restart required"),
    );
  });

  it.each([
    { command: ["gateway", "status"] },
    { command: ["plugins", "list"], metadataOnly: true },
  ])(
    "leaves config intact when the host only loads the plugin for $command",
    async (args) => {
      const h = await loadPlugin(args);
      expect(h.mutateConfigFile).not.toHaveBeenCalled();
      expect(h.read()).toEqual(h.config);
    },
  );

  it("does not register hook policy startup for a host below the version gate", async () => {
    const h = await loadPlugin({ version: "2026.4.23" });
    expect(
      h.services.find((entry) => entry.id === "memory-tencentdb-hook-policy"),
    ).toBeUndefined();
    expect(h.read()).toEqual(h.config);
  });
});
