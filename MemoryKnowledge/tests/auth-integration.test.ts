import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";

interface NodeRequestInitWithDuplex extends RequestInit {
  duplex?: "half";
}

interface AppInstanceTracker {
  close: () => void;
  rootDir: string;
}

const createdApps: AppInstanceTracker[] = [];

afterEach(() => {
  for (const item of createdApps.splice(0)) {
    try {
      item.close();
    } catch {}
    try {
      rmSync(item.rootDir, { recursive: true, force: true });
    } catch {}
  }
});

function setupApp(serviceKey = "correct-service-key-9876", apiPrefix = "/v3") {
  const rootDir = mkdtempSync(join(tmpdir(), "auth-test-"));
  const dataDir = join(rootDir, "data");
  const dbPath = join(rootDir, "knowledge.db");

  const appInstance = createApp({
    dataDir,
    dbPath,
    apiPrefix,
    auth: {
      serviceKey,
      allowInsecureNoKeyListen: false,
    },
    clickhouse: {
      enabled: false,
      url: "",
      database: "default",
      table: "tool_call_logs",
      user: "default",
      password: "",
      flushIntervalMs: 5000,
      flushThreshold: 50,
      ttlDays: 90,
      requestTimeoutMs: 5000,
    },
  });

  createdApps.push({
    close: appInstance.close,
    rootDir,
  });

  return { app: appInstance.app, config: appInstance.config, close: appInstance.close };
}

function createTrackedSecretStream(secretPayload: Record<string, unknown>) {
  let pullCount = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pullCount++;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(secretPayload)));
        controller.close();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
  );
  return {
    stream,
    getPullCount: () => pullCount,
  };
}

describe("Knowledge Service Authentication & Security Pipeline", () => {
  describe("Public endpoints", () => {
    it("allows public access to /health without credentials even when serviceKey is set", async () => {
      const { app } = setupApp();
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({ status: "ok" });
    });

    it("allows public access to /docs and /openapi.json", async () => {
      const { app } = setupApp();
      const resDocs = await app.request("/docs");
      expect(resDocs.status).toBe(200);

      const resSpec = await app.request("/openapi.json");
      expect(resSpec.status).toBe(200);
    });
  });

  describe("Enforcing service key on ALL service API routes (no read-only bypass)", () => {
    it.each([
      // Read routes (previously bypassed via READONLY_POST_PATHS)
      ["POST", "/v3/wiki/page/read", { wiki_id: "w1", refs: ["p1"] }],
      ["POST", "/v3/wiki/raw/read", { wiki_id: "w1", filenames: ["f1.md"] }],
      ["POST", "/v3/wiki/search", { wiki_id: "w1", query: "security" }],
      ["POST", "/v3/wiki/get", { wiki_id: "w1" }],
      ["POST", "/v3/wiki/list", { team_id: "t1" }],
      ["POST", "/v3/wiki/graph", { wiki_id: "w1" }],
      ["POST", "/v3/wiki/page/ls", { wiki_id: "w1" }],
      ["POST", "/v3/wiki/raw/ls", { wiki_id: "w1" }],
      ["POST", "/v3/code-graph/list", { team_id: "t1" }],
      ["POST", "/v3/code-graph/get", { code_graph_id: "cg1" }],
      // Tools routes (previously bypassed)
      ["POST", "/v3/tools/list", { knowledge_id: "w1" }],
      ["POST", "/v3/tools/call", { knowledge_id: "w1", tool_name: "search", params: {} }],
      // Write / mutation routes
      ["POST", "/v3/wiki/create", { team_id: "t1", name: "Wiki 1" }],
      ["POST", "/v3/wiki/page/write", { team_id: "t1", wiki_id: "w1", pages: [] }],
      ["POST", "/v3/wiki/okf/import", { team_id: "t1", wiki_id: "w1", files: [] }],
      // Internal & management routes
      ["POST", "/v3/internal/llm-binding/status", { team_id: "t1" }],
      ["POST", "/v3/internal/llm-binding/list", {}],
      ["GET", "/v3/auto-sync/status", undefined],
    ])("rejects unauthenticated %s %s with 401", async (method, path, body) => {
      const { app } = setupApp();
      const headers: Record<string, string> = {
        "x-tdai-service-id": "test-service",
      };
      if (body) headers["Content-Type"] = "application/json";

      const res = await app.request(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe(401);
      expect(json.message).toContain("unauthorized: valid service key required");
    });
  });

  describe("Caller-supplied tenant headers do NOT authenticate", () => {
    it("rejects caller with arbitrary x-tdai-service-id and team_id if serviceKey is missing", async () => {
      const { app } = setupApp();
      const res = await app.request("/v3/wiki/page/read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "privileged-service",
          "x-tdai-team-id": "privileged-team",
          "x-tdai-user-id": "admin",
        },
        body: JSON.stringify({ wiki_id: "w1", refs: ["index"] }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("Invalid or wrong credentials", () => {
    it("rejects incorrect Bearer token", async () => {
      const { app } = setupApp();
      const res = await app.request("/v3/wiki/page/read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-a",
          "Authorization": "Bearer wrong-token-value-xyz",
        },
        body: JSON.stringify({ wiki_id: "w1", refs: ["index"] }),
      });

      expect(res.status).toBe(401);
    });

    it("rejects non-Bearer authentication schemes", async () => {
      const { app } = setupApp();
      const res = await app.request("/v3/wiki/page/read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-a",
          "Authorization": "Basic dXNlcjpwYXNz",
        },
        body: JSON.stringify({ wiki_id: "w1", refs: ["index"] }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("Correct Bearer authentication & cross-tenant authorization", () => {
    it("allows operations with correct Bearer token and enforces multi-tenancy isolation", async () => {
      const { app } = setupApp("secret-token-123");
      const authHeader = "Bearer secret-token-123";

      // 1. Create wiki for service-a
      const createRes = await app.request("/v3/wiki/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-a",
          "Authorization": authHeader,
        },
        body: JSON.stringify({ team_id: "team-a", name: "Alpha Wiki" }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const wikiId = created.data.wiki_id;
      expect(wikiId).toMatch(/^wiki-/);

      // 2. Query wiki list for service-a -> succeeds and finds wiki
      const listResA = await app.request("/v3/wiki/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-a",
          "Authorization": authHeader,
        },
        body: JSON.stringify({ team_id: "team-a" }),
      });
      expect(listResA.status).toBe(200);
      const listA = await listResA.json();
      expect(listA.data.items.some((w: any) => w.wiki_id === wikiId)).toBe(true);

      // 3. Service-B with the SAME service key queries service-a's wiki -> 404 (multi-tenant boundary respected)
      const getResB = await app.request("/v3/wiki/get", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-b",
          "Authorization": authHeader,
        },
        body: JSON.stringify({ wiki_id: wikiId }),
      });
      expect(getResB.status).toBe(404);

      // 4. Tools list on created wiki with valid auth and correct tenant -> succeeds
      const toolsRes = await app.request("/v3/tools/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-a",
          "Authorization": authHeader,
        },
        body: JSON.stringify({ knowledge_id: wikiId }),
      });
      expect(toolsRes.status).toBe(200);
      const toolsJson = await toolsRes.json();
      expect(toolsJson.data.knowledge_id).toBe(wikiId);
      expect(Array.isArray(toolsJson.data.tools)).toBe(true);
    });
  });

  describe("Custom apiPrefix", () => {
    it("respects custom API prefix for authentication and public health", async () => {
      const { app } = setupApp("custom-key-xyz", "/api/knowledge");

      // Public health is still at /health
      const health = await app.request("/health");
      expect(health.status).toBe(200);

      // Custom prefix requires Bearer
      const unauth = await app.request("/api/knowledge/wiki/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-a",
        },
        body: JSON.stringify({ team_id: "team-a" }),
      });
      expect(unauth.status).toBe(401);

      // Valid Bearer succeeds under custom prefix
      const auth = await app.request("/api/knowledge/wiki/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-a",
          "Authorization": "Bearer custom-key-xyz",
        },
        body: JSON.stringify({ team_id: "team-a" }),
      });
      expect(auth.status).toBe(200);
    });
  });

  describe("Request body non-consumption & credential leakage prevention", () => {
    it.each([
      // Read route
      ["POST", "/v3/wiki/search", { wiki_id: "w1", query: "TOP_SECRET_SEARCH_QUERY_456" }],
      // Write route
      ["POST", "/v3/wiki/okf/import", { team_id: "t1", wiki_id: "w1", files: [{ path: "p.md", content: "SECRET_WRITE_CONTENT" }] }],
      // Tools route
      ["POST", "/v3/tools/call", { knowledge_id: "w1", tool_name: "search", params: { q: "SECRET_TOOL_QUERY" } }],
    ])("rejects unauthenticated %s %s without pulling stream or consuming body (pull=0, bodyUsed=false)", async (method, path, secretPayload) => {
      const { app } = setupApp("super-secret-key-4321");

      const loggedMessages: string[] = [];
      const spyLog = vi.spyOn(console, "log").mockImplementation((...args) => {
        loggedMessages.push(args.map(String).join(" "));
      });
      const spyWarn = vi.spyOn(console, "warn").mockImplementation((...args) => {
        loggedMessages.push(args.map(String).join(" "));
      });
      const spyError = vi.spyOn(console, "error").mockImplementation((...args) => {
        loggedMessages.push(args.map(String).join(" "));
      });
      const spyInfo = vi.spyOn(console, "info").mockImplementation((...args) => {
        loggedMessages.push(args.map(String).join(" "));
      });

      try {
        const { stream, getPullCount } = createTrackedSecretStream(secretPayload);

        const init: NodeRequestInitWithDuplex = {
          method,
          headers: {
            "Content-Type": "application/json",
            "x-tdai-service-id": "tenant-x",
          },
          body: stream,
          duplex: "half",
        };

        const req = new Request(`http://localhost${path}`, init);
        const res = await app.fetch(req);

        expect(res.status).toBe(401);

        // Verification 1: stream pull was never invoked (pullCount === 0)
        expect(getPullCount()).toBe(0);

        // Verification 2: request body was not marked used
        expect(req.bodyUsed).toBe(false);

        // Verification 3: logger never logged any part of the secret payload or serviceKey
        const allLogs = loggedMessages.join("\n");
        for (const val of Object.values(secretPayload)) {
          if (typeof val === "string") {
            expect(allLogs).not.toContain(val);
          }
        }
        expect(allLogs).not.toContain("super-secret-key-4321");
      } finally {
        spyLog.mockRestore();
        spyWarn.mockRestore();
        spyError.mockRestore();
        spyInfo.mockRestore();
      }
    });

    it("verifies unauthenticated stream non-consumption under custom apiPrefix as well", async () => {
      const { app } = setupApp("super-custom-key-777", "/custom/api");

      const { stream, getPullCount } = createTrackedSecretStream({
        wiki_id: "w-custom",
        query: "SECRET_CUSTOM_PREFIX_QUERY",
      });

      const init: NodeRequestInitWithDuplex = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "tenant-custom",
        },
        body: stream,
        duplex: "half",
      };

      const req = new Request("http://localhost/custom/api/wiki/search", init);
      const res = await app.fetch(req);

      expect(res.status).toBe(401);
      expect(getPullCount()).toBe(0);
      expect(req.bodyUsed).toBe(false);
    });

    it("never logs provided incorrect credentials or configured service key", async () => {
      const { app } = setupApp("configured-secret-key-abc");

      const loggedMessages: string[] = [];
      const spyLog = vi.spyOn(console, "log").mockImplementation((...args) => {
        loggedMessages.push(args.map(String).join(" "));
      });
      const spyWarn = vi.spyOn(console, "warn").mockImplementation((...args) => {
        loggedMessages.push(args.map(String).join(" "));
      });
      const spyError = vi.spyOn(console, "error").mockImplementation((...args) => {
        loggedMessages.push(args.map(String).join(" "));
      });
      const spyInfo = vi.spyOn(console, "info").mockImplementation((...args) => {
        loggedMessages.push(args.map(String).join(" "));
      });

      try {
        const providedWrongKey = "provided-wrong-credential-xyz";
        const res = await app.request("/v3/wiki/page/read", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tdai-service-id": "service-a",
            "Authorization": `Bearer ${providedWrongKey}`,
          },
          body: JSON.stringify({ wiki_id: "w1", refs: ["index"] }),
        });
        expect(res.status).toBe(401);

        const allLogs = loggedMessages.join("\n");
        expect(allLogs).not.toContain(providedWrongKey);
        expect(allLogs).not.toContain("configured-secret-key-abc");
      } finally {
        spyLog.mockRestore();
        spyWarn.mockRestore();
        spyError.mockRestore();
        spyInfo.mockRestore();
      }
    });
  });

  describe("Insecure no-key local development mode", () => {
    it("allows requests when serviceKey is explicitly empty (local loopback mode)", async () => {
      const { app } = setupApp(""); // serviceKey: ""

      const res = await app.request("/v3/wiki/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-dev",
        },
        body: JSON.stringify({ team_id: "team-dev" }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("OKF streaming body limit preservation", () => {
    it("preserves 20MB body limit for authenticated OKF requests", async () => {
      const { app } = setupApp("test-key");

      // Payload slightly over 20MB
      const hugePayload = "X".repeat(21 * 1024 * 1024);
      const res = await app.request("/v3/wiki/okf/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-a",
          "Authorization": "Bearer test-key",
        },
        body: JSON.stringify({ team_id: "team-a", wiki_id: "w1", data: hugePayload }),
      });

      expect(res.status).toBe(413);
    });

    it("rejects unauthenticated OKF requests with 401 before bodyLimit consumes the body", async () => {
      const { app } = setupApp("test-key");

      const res = await app.request("/v3/wiki/okf/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": "service-a",
        },
        body: JSON.stringify({ team_id: "team-a", wiki_id: "w1", files: [] }),
      });

      expect(res.status).toBe(401);
    });
  });
});
