/**
 * tz-08 — shared rig for the consumer parity work: a real gateway process, a
 * fake model at the HTTP boundary, and MCP hosts started exactly the way the
 * registry says they are.
 *
 * The model is faked at the boundary, never in code: the whole path
 * note → L0 → L1 → index runs the product's own code, and only the answer that
 * would have come from an API is ours. Without it a probe claiming "the note is
 * findable again" would depend on a live model — an untestable promise.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { HostDescriptor } from "../../src/consumer/hosts/types.js";

export const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);

/** One extraction the fake model always returns, whatever it is asked. */
const EXTRACTION = [
  {
    scene_name: "Проверка потребителя памяти",
    message_ids: ["1"],
    memories: [
      {
        content:
          "Пользователь проверяет границу потребителя памяти под тремя хостами",
        type: "episodic",
        scope: "project",
        priority: 60,
        source_message_ids: ["1"],
      },
    ],
  },
];

export interface FakeLlm {
  url: string;
  /** How many completions were asked for — proof the product path used it. */
  calls: () => number;
  close: () => Promise<void>;
}

/** OpenAI-compatible endpoint returning a fixed, parseable extraction. */
export async function startFakeLlm(
  answer: unknown = EXTRACTION,
): Promise<FakeLlm> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "fake",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "fake-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(answer) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls: () => calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A fixed-dimension embedding endpoint (OpenAI `/embeddings` shape). */
export async function startFakeEmbeddings(dim = 8): Promise<FakeLlm> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls += 1;
      // Deterministic pseudo-vector from the request text: same text, same
      // vector, so ordering is reproducible across runs.
      const seed = [...body].reduce((a, ch) => (a + ch.charCodeAt(0)) % 997, 7);
      const vector = Array.from({ length: dim }, (_, i) =>
        Number((Math.sin(seed + i) / 2 + 0.5).toFixed(6)),
      );
      const input = (JSON.parse(body || "{}") as { input?: unknown }).input;
      const rows = Array.isArray(input) ? input.length : 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          model: "fake-embed",
          data: Array.from({ length: rows }, (_, i) => ({
            object: "embedding",
            index: i,
            embedding: vector,
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls: () => calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export interface SandboxConfig {
  dataDir: string;
  port: number;
  /** Fake OpenAI-compatible base URL for extraction. */
  llmUrl: string;
  /** `none` keeps the store without an embedding service. */
  embedding?:
    { provider: "none" } | { provider: "openai"; baseUrl: string; dim: number };
}

/** Write the gateway's yaml for a sandbox and return its path. */
export function writeSandboxConfig(
  configPath: string,
  cfg: SandboxConfig,
): string {
  const embedding =
    cfg.embedding && cfg.embedding.provider !== "none"
      ? [
          "  embedding:",
          "    enabled: true",
          "    provider: openai",
          `    baseUrl: ${JSON.stringify(cfg.embedding.baseUrl)}`,
          "    apiKey: fake",
          "    model: fake-embed",
          `    dimensions: ${cfg.embedding.dim}`,
        ]
      : ["  embedding:", "    enabled: false", "    provider: none"];

  const yaml = [
    "server:",
    `  port: ${cfg.port}`,
    "  host: 127.0.0.1",
    "data:",
    `  baseDir: ${JSON.stringify(cfg.dataDir)}`,
    "llm:",
    `  baseUrl: ${JSON.stringify(cfg.llmUrl)}`,
    "  apiKey: fake",
    "  model: fake-model",
    "memory:",
    "  llm:",
    // Without this the runtime falls back to the HOST's runner and the fake
    // base URL is never consulted (tdai-core.ts wirePipelineRunners).
    "    enabled: true",
    `    baseUrl: ${JSON.stringify(cfg.llmUrl)}`,
    "    apiKey: fake",
    "    model: fake-model",
    "  extraction:",
    "    enabled: true",
    ...embedding,
    "",
  ].join("\n");
  fs.writeFileSync(configPath, yaml, "utf-8");
  return configPath;
}

export interface Gateway {
  port: number;
  url: string;
  proc: ChildProcess;
  log: () => string;
  stop: () => Promise<void>;
}

/** Boot a REAL gateway process, the way a user boots it. */
export async function startGateway(opts: {
  home: string;
  dataDir: string;
  port: number;
  configPath: string;
}): Promise<Gateway> {
  const proc = spawn("npx", ["tsx", "src/gateway/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: opts.home,
      TDAI_DATA_DIR: opts.dataDir,
      TDAI_GATEWAY_PORT: String(opts.port),
      TDAI_GATEWAY_CONFIG: opts.configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout?.on("data", (b: Buffer) => (log += b.toString()));
  proc.stderr?.on("data", (b: Buffer) => (log += b.toString()));

  const url = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/status`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`gateway did not answer /status within 90s:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  return {
    port: opts.port,
    url,
    proc,
    log: () => log,
    stop: async () => {
      proc.kill();
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

export interface McpHost {
  id: string;
  /** Exactly what started it — printed so the reader sees three real forms. */
  commandLine: string;
  call: (method: string, params: unknown) => Promise<Record<string, unknown>>;
  stop: () => void;
}

/** Start one host EXACTLY as its descriptor says, and speak MCP to it. */
export async function startHost(
  descriptor: HostDescriptor,
  extraEnv: Record<string, string> = {},
): Promise<McpHost> {
  const child = spawn(descriptor.command, [...descriptor.args], {
    env: { ...process.env, ...descriptor.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = new Map<number, Record<string, unknown>>();
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === "number") {
        replies.set(message.id, message as Record<string, unknown>);
      }
    }
  });

  let nextId = 1;
  const call = async (method: string, params: unknown) => {
    const id = nextId++;
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    const deadline = Date.now() + 30_000;
    while (!replies.has(id)) {
      if (Date.now() > deadline)
        throw new Error(`${descriptor.id}: no reply to ${method}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return replies.get(id)!;
  };

  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tz08", version: "0" },
  });
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  return {
    id: descriptor.id,
    commandLine: `${descriptor.command} ${descriptor.args.join(" ")}`,
    call,
    stop: () => void child.kill(),
  };
}

/** Wait until `check` holds, or fail naming what never happened. */
export async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
