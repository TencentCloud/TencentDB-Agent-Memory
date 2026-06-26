import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";
import { TdaiGateway } from "./server.js";

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function postJson<T>(port: number, pathName: string, body: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
  } catch {
    return [];
  }
}

describe("TdaiGateway user scoping", () => {
  let gateway: TdaiGateway | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop();
      gateway = undefined;
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  it("does not expose legacy persona data to a non-default user_id", async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-gateway-user-scope-"));
    await writeFile(
      path.join(dataDir, "persona.md"),
      "Alice legacy private persona marker",
      "utf-8",
    );
    const port = await pickFreePort();
    const memory = parseConfig({
      extraction: { enabled: false },
      embedding: { provider: "none" },
      recall: { strategy: "keyword" },
    });

    gateway = new TdaiGateway({
      server: { host: "127.0.0.1", port, corsOrigins: [] },
      data: { baseDir: dataDir },
      memory,
    });
    await gateway.start();

    const bobRecall = await postJson<{ context: string; memory_count: number }>(port, "/recall", {
      user_id: "bob",
      session_key: "shared-session",
      query: "private persona marker",
    });
    expect(bobRecall.context).toBe("");
    expect(bobRecall.memory_count).toBe(0);

    const defaultRecall = await postJson<{ context: string; memory_count: number }>(port, "/recall", {
      session_key: "shared-session",
      query: "private persona marker",
    });
    expect(defaultRecall.context).toContain("Alice legacy private persona marker");

    const defaultAliasRecall = await postJson<{ context: string; memory_count: number }>(port, "/recall", {
      user_id: "default",
      session_key: "shared-session",
      query: "private persona marker",
    });
    expect(defaultAliasRecall.context).toContain("Alice legacy private persona marker");
  });

  it("captures non-default user_id data outside the legacy base directory", async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-gateway-user-scope-"));
    const port = await pickFreePort();
    const memory = parseConfig({
      extraction: { enabled: false },
      embedding: { provider: "none" },
      recall: { strategy: "keyword" },
    });

    gateway = new TdaiGateway({
      server: { host: "127.0.0.1", port, corsOrigins: [] },
      data: { baseDir: dataDir },
      memory,
    });
    await gateway.start();

    const now = Date.now() + 10_000;
    const capture = await postJson<{ l0_recorded: number }>(port, "/capture", {
      user_id: "alice",
      session_key: "shared-session",
      user_content: "alice private sentinel project alpha",
      assistant_content: "acknowledged alice private sentinel project alpha",
      messages: [
        { role: "user", content: "alice private sentinel project alpha", timestamp: now },
        { role: "assistant", content: "acknowledged alice private sentinel project alpha", timestamp: now + 1 },
      ],
    });
    expect(capture.l0_recorded).toBeGreaterThan(0);

    const legacyFiles = await listJsonlFiles(path.join(dataDir, "conversations"));
    expect(legacyFiles).toEqual([]);

    const scopedFiles = await listJsonlFiles(path.join(dataDir, "users"));
    expect(scopedFiles.length).toBeGreaterThan(0);
    const scopedText = (await Promise.all(scopedFiles.map((file) => readFile(file, "utf-8")))).join("\n");
    expect(scopedText).toContain("alice private sentinel project alpha");
  });
});
