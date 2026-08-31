import http from "node:http";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TdaiGateway } from "./server.js";

describe("TdaiGateway /health", () => {
  let gateway: TdaiGateway | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop();
      gateway = undefined;
    }
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  it("returns safe diagnostics for the running process and data directory", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "tdai-gateway-health-"));
    const secretApiKey = "secret-gateway-health-token";
    const secretLlmKey = "secret-gateway-llm-token";

    gateway = new TdaiGateway({
      server: {
        host: "127.0.0.1",
        port: 0,
        apiKey: secretApiKey,
      },
      data: {
        baseDir: dataDir,
      },
      llm: {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: secretLlmKey,
        model: "test-model",
        maxTokens: 1,
        timeoutMs: 100,
      },
    });

    await gateway.start();

    const server = (gateway as unknown as { server: http.Server | null }).server;
    const address = server?.address();
    if (!address || typeof address === "string") {
      throw new Error("Gateway test server did not bind to a TCP port");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.diagnostics).toMatchObject({
      process: {
        pid: process.pid,
        cwd: process.cwd(),
        home: homedir(),
      },
      gateway: {
        host: "127.0.0.1",
        port: address.port,
        dataDir,
      },
    });
    expect(body.diagnostics.process.user).toEqual(expect.any(String));

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(secretApiKey);
    expect(serialized).not.toContain(secretLlmKey);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("TDAI_GATEWAY_API_KEY");
    expect(serialized).not.toContain("TDAI_LLM_API_KEY");
  });
});
