import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../config.js";
import { TdaiGateway } from "./server.js";

let gateway: TdaiGateway | undefined;
let dataDir: string | undefined;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  try {
    if (gateway) await gateway.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } finally {
    gateway = undefined;
    dataDir = undefined;
    vi.restoreAllMocks();
  }
});

describe("Gateway capture started_at", () => {
  it("keeps an external adapter's first turn ahead of the cold-start cursor", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "tdai-gateway-adapter-capture-"));
    gateway = new TdaiGateway({
      server: { host: "127.0.0.1", port: 0, corsOrigins: [] },
      data: { baseDir: dataDir },
      llm: {
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-only",
        model: "test-only",
        maxTokens: 16,
        timeoutMs: 100,
        disableThinking: false,
      },
      memory: parseConfig({
        extraction: { enabled: false },
        embedding: { enabled: false },
        pipeline: {
          enableWarmup: false,
          everyNConversations: 100,
          l1IdleTimeoutSeconds: 3600,
        },
      }),
    });
    await gateway.start();

    const server = (gateway as any).server;
    const address = server?.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind to a TCP port");
    const messageTimestamp = Date.now() - 60_000;
    const response = await fetch(`http://127.0.0.1:${address.port}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_content: "Remember pr323-started-at-marker.",
        assistant_content: "Stored pr323-started-at-marker.",
        session_key: "adapter-cold-start",
        session_id: "adapter-cold-start-run",
        messages: [
          { role: "user", content: "Remember pr323-started-at-marker.", timestamp: messageTimestamp },
          { role: "assistant", content: "Stored pr323-started-at-marker.", timestamp: messageTimestamp },
        ],
        started_at: messageTimestamp - 1,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      l0_recorded: 2,
      scheduler_notified: false,
    });
  });
});
