import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";
import { freePort } from "../test-support/free-port.js";
import { TdaiGateway } from "./server.js";

let root: string;
let gateway: TdaiGateway;
let baseUrl: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-auth-"));
  const port = await freePort();
  gateway = new TdaiGateway({
    data: { baseDir: path.join(root, "memory") },
    server: { host: "127.0.0.1", port, corsOrigins: [] },
    memory: parseConfig({ extraction: { enabled: false } }),
  });
  await gateway.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await gateway.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("mandatory mutation auth", () => {
  for (const route of ["/capture", "/session/end", "/seed"]) {
    it(`rejects unauthenticated POST ${route}`, async () => {
      const response = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
    });
  }
});
