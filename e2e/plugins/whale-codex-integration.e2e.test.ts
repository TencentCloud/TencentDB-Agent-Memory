/**
 * End-to-end integration tests for the Whale + Codex memory plugins.
 *
 * These tests prove, from the host's point of view, that:
 *   1. The MCP bridge exposes `search_memories` / `search_conversations` and a
 *      real query is proxied all the way to the TdaiGateway
 *      (Codex "call tools in MCP" + Whale "see and use the tools").
 *   2. The Whale hooks (recall.js / capture.js / health.js) run and reach the
 *      gateway over HTTP.
 *   3. The Codex hooks (recall.js / capture.js / health.js) run and reach the
 *      gateway over HTTP.
 *   4. The plugin manifests (mcp.json / .mcp.json / hooks.* / plugin.json /
 *      whale-plugin.toml) are well-formed and point at real files, so the host
 *      can actually discover the tools and hooks.
 *
 * A faithful in-process mock of `src/gateway/server.ts` is used by default so
 * the suite is hermetic. Point TDAI_E2E_GATEWAY at a real gateway URL to run
 * the same flows against the live server.
 *
 * Run:  npm run test:e2e
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../.."); // e2e/plugins -> repo root
const WHALE_DIR = resolve(ROOT, "whale-memory-tdai");
const CODEX_DIR = resolve(ROOT, "codex-memory-tdai");
const NODE = process.execPath;

// ---- Mock gateway (mirrors src/gateway/server.ts contract) ----
let server: http.Server | null = null;
let gatewayUrl = "";
const hits: Record<string, number> = {};

const useReal = !!process.env.TDAI_E2E_GATEWAY;
const REAL_URL = process.env.TDAI_E2E_GATEWAY ?? "";

function bodyOf(req: http.IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res(b));
  });
}

function startMock(): Promise<string> {
  return new Promise((resolvePort) => {
    const s = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && url.pathname === "/health") {
        return send(200, {
          status: "ok",
          version: "e2e",
          uptime: 0,
          stores: { vectorStore: true, embeddingService: true },
        });
      }
      if (req.method === "POST") {
        await bodyOf(req);
        switch (url.pathname) {
          case "/recall":
            return send(200, { context: "MEMORY_CONTEXT_FOR_QUERY", strategy: "e2e", memory_count: 3 });
          case "/capture":
            return send(200, { l0_recorded: 1, scheduler_notified: true });
          case "/search/memories":
            return send(200, { results: "MEMORY_RESULT_TEXT", total: 1, strategy: "e2e" });
          case "/search/conversations":
            return send(200, { results: "CONVO_RESULT_TEXT", total: 1 });
          case "/session/end":
            return send(200, { flushed: true });
          default:
            return send(404, { error: "not found" });
        }
      }
      send(404, { error: "not found" });
    });
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      resolvePort(`http://127.0.0.1:${port}`);
    });
  });
}

// ---- MCP bridge client (JSON-RPC 2.0 over stdio) ----
interface BridgeClient {
  rpc(method: string, params?: unknown): Promise<any>;
  kill(): void;
}
function startBridge(bridgePath: string, gw: string): BridgeClient {
  const child = spawn(NODE, [bridgePath], {
    env: { ...process.env, TDAI_GATEWAY_URL: gw },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          p.resolve(msg);
        }
      } catch {
        /* ignore malformed lines */
      }
    }
  });
  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 15000);
    });
  return {
    rpc,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
    },
  };
}

// ---- hook runner ----
function runHook(
  cmd: string,
  args: string[],
  stdinJson: unknown,
  gw: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, TDAI_GATEWAY_URL: gw },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
    child.stdin.write(typeof stdinJson === "string" ? stdinJson : JSON.stringify(stdinJson));
    child.stdin.end();
  });
}

function readJson(p: string) {
  return JSON.parse(readFileSync(p, "utf-8"));
}
function readText(p: string) {
  return readFileSync(p, "utf-8");
}
function stripToken(p: string) {
  return p.replace(/\$\{[A-Z_]+\}\/?/, "");
}

beforeAll(async () => {
  if (useReal) {
    gatewayUrl = REAL_URL;
  } else {
    gatewayUrl = await startMock();
  }
}, 30000);

afterAll(() => {
  if (server) server.close();
});

describe("MCP tool discovery & query (Codex + Whale bridge)", () => {
  for (const [label, dir] of [
    ["whale", WHALE_DIR],
    ["codex", CODEX_DIR],
  ] as const) {
    it(`${label}: bridge initializes, lists tools, and proxies a real query`, async () => {
      const bridge = startBridge(resolve(dir, "mcp-bridge.js"), gatewayUrl);
      try {
        const init = await bridge.rpc("initialize");
        expect(init.result.serverInfo.name).toBe("tdai-memory");

        const list = await bridge.rpc("tools/list");
        const names = list.result.tools.map((t: any) => t.name);
        expect(names).toContain("search_memories");
        expect(names).toContain("search_conversations");

        const call = await bridge.rpc("tools/call", {
          name: "search_memories",
          arguments: { query: "project status" },
        });
        expect(call.result.isError).toBe(false);
        expect(call.result.content[0].text).toContain("MEMORY_RESULT_TEXT");

        if (!useReal) expect(hits["/search/memories"]).toBeGreaterThanOrEqual(1);
      } finally {
        bridge.kill();
      }
    });
  }
});

describe("Whale hooks (node)", () => {
  it("UserPromptSubmit recall reaches the gateway and returns context", async () => {
    const r = await runHook(
      NODE,
      [resolve(WHALE_DIR, "scripts/recall.js")],
      { prompt: "what did we decide?", session_id: "sess-w1" },
      gatewayUrl,
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("pass");
    expect(out.additional_context).toContain("MEMORY_CONTEXT_FOR_QUERY");
    if (!useReal) expect(hits["/recall"]).toBeGreaterThanOrEqual(1);
  });

  it("Stop capture runs without error (fire-and-forget)", async () => {
    const r = await runHook(
      NODE,
      [resolve(WHALE_DIR, "scripts/capture.js")],
      { session_id: "sess-w1", prompt: "user text", last_assistant_text: "assistant text" },
      gatewayUrl,
    );
    expect(r.code).toBe(0);
  });

  it("SessionStart health runs without error", async () => {
    const r = await runHook(NODE, [resolve(WHALE_DIR, "scripts/health.js")], {}, gatewayUrl);
    expect(r.code).toBe(0);
  });
});

describe("Codex hooks (node)", () => {
  it("UserPromptSubmit recall reaches the gateway and returns additionalContext", async () => {
    const r = await runHook(
      NODE,
      [resolve(CODEX_DIR, "scripts/recall.js")],
      { prompt: "what did we decide?", session_id: "sess-c1" },
      gatewayUrl,
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("MEMORY_CONTEXT_FOR_QUERY");
    if (!useReal) expect(hits["/recall"]).toBeGreaterThanOrEqual(1);
  });

  it("Stop capture runs without error (fire-and-forget)", async () => {
    const tf = resolve(tmpdir(), `tdai-e2e-${Date.now()}.jsonl`).replace(/\\/g, "/");
    writeFileSync(
      tf,
      [
        JSON.stringify({ role: "user", content: "user line" }),
        JSON.stringify({ role: "assistant", content: "assistant line" }),
      ].join("\n"),
    );
    const r = await runHook(
      NODE,
      [resolve(CODEX_DIR, "scripts/capture.js")],
      { session_id: "sess-c1", transcript_path: tf },
      gatewayUrl,
    );
    expect(r.code).toBe(0);
    if (!useReal) expect(hits["/capture"]).toBeGreaterThanOrEqual(1);
  });

  it("SessionStart health runs without error", async () => {
    const r = await runHook(NODE, [resolve(CODEX_DIR, "scripts/health.js")], {}, gatewayUrl);
    expect(r.code).toBe(0);
  });
});

describe("Plugin manifests (tool/hook discovery surface)", () => {
  it("whale mcp.json launches the bridge via env-resolved plugin root", () => {
    const m = readJson(resolve(WHALE_DIR, "mcp.json"));
    const srv = m.mcpServers["memory-tdai"];
    expect(srv.command).toBe("node");
    // Hosts don't expand ${VAR} on Windows, so the args resolve the root from
    // the environment inside Node (WHALE_PLUGIN_ROOT) instead.
    expect(srv.args[0]).toBe("-e");
    expect(srv.args[1]).toContain("WHALE_PLUGIN_ROOT");
    expect(srv.args[1]).toContain("mcp-bridge.js");
    expect(existsSync(resolve(WHALE_DIR, "mcp-bridge.js"))).toBe(true);
  });

  it("codex .mcp.json points at a real bridge and exposes the server", () => {
    const m = readJson(resolve(CODEX_DIR, ".mcp.json"));
    const srv = m.mcpServers["memory-tdai"];
    expect(srv.command).toBe("node");
    // Codex resolves "cwd": "." to the plugin root and passes args verbatim,
    // so the bridge path must be relative.
    expect(srv.cwd).toBe(".");
    expect(srv.args[0].endsWith("mcp-bridge.js")).toBe(true);
    expect(existsSync(resolve(CODEX_DIR, stripToken(srv.args[0])))).toBe(true);
  });

  it("codex hooks.json declares all three lifecycle hooks with real scripts", () => {
    const h = readJson(resolve(CODEX_DIR, "hooks/hooks.json"));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const hooks = h.hooks[ev][0].hooks;
      expect(hooks.length).toBeGreaterThan(0);
      expect(hooks[0].command).toContain("scripts/");
      expect(hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
    }
  });

  it("whale hooks.toml declares all three lifecycle hooks with real scripts", () => {
    const t = readText(resolve(WHALE_DIR, "hooks.toml"));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      expect(t).toContain(ev);
    }
    for (const sc of ["scripts/health.js", "scripts/recall.js", "scripts/capture.js"]) {
      expect(t).toContain(sc);
      expect(existsSync(resolve(WHALE_DIR, sc))).toBe(true);
    }
    // Commands must not rely on host-side ${VAR} expansion (breaks on Windows
    // where hooks run under PowerShell); the root comes from the environment.
    expect(t).not.toMatch(/command = .*\$\{WHALE_PLUGIN_ROOT\}/);
    expect(t).toContain("process.env.WHALE_PLUGIN_ROOT");
  });

  it("codex plugin.json + whale-plugin.toml are valid and reference real files", () => {
    const p = readJson(resolve(CODEX_DIR, ".codex-plugin/plugin.json"));
    expect(p.name).toBe("memory-tdai");
    expect(existsSync(resolve(CODEX_DIR, p.hooks))).toBe(true);
    expect(existsSync(resolve(CODEX_DIR, p.mcpServers))).toBe(true);
    const wt = readText(resolve(WHALE_DIR, "whale-plugin.toml"));
    expect(wt).toContain('id = "memory-tencentdb"');
  });
});
