/**
 * eval-memory — Gateway access.
 *
 * Two modes:
 *  - spawned (default): each conversation gets its own short-lived Gateway
 *    process with a fresh TDAI_DATA_DIR, so recall for conversation A can
 *    never surface memories from conversation B. This mirrors the
 *    one-instance-per-user deployment shape and is what makes runs
 *    reproducible from a clean state.
 *  - external (--gateway-url): reuse a Gateway the caller manages. Useful
 *    against docker deployments, but the caller owns data isolation.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  EvalGateway,
  PipelineStatus,
  RecallResult,
} from "./types.js";

const TAG = "[eval-memory]";

// Dummy v2 credentials: parseV2Auth requires non-empty Bearer + service id
// even when the standalone Gateway has no API key configured.
const EVAL_SERVICE_ID = "eval-memory";

export interface HttpGatewayOptions {
  baseUrl: string;
  apiKey?: string;
  fetchTimeoutMs?: number;
}

export class HttpEvalGateway implements EvalGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly child?: ChildProcess;

  constructor(opts: HttpGatewayOptions, child?: ChildProcess) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey || "eval";
    this.timeoutMs = opts.fetchTimeoutMs ?? 120_000;
    this.child = child;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    // v1 routes ignore these headers when the Gateway has no API key;
    // v2 routes require them to be non-empty regardless.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      "x-tdai-service-id": EVAL_SERVICE_ID,
    };
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  async capture(sessionKey: string, user: string, assistant: string): Promise<void> {
    await this.post("/capture", {
      user_content: user,
      assistant_content: assistant,
      session_key: sessionKey,
    });
  }

  async sessionEnd(sessionKey: string): Promise<void> {
    await this.post("/session/end", { session_key: sessionKey });
  }

  async pipelineStatus(): Promise<PipelineStatus | null> {
    try {
      const envelope = await this.post<{ code: number; data?: PipelineStatus }>(
        "/v2/pipeline/status",
        {},
      );
      if (envelope.code !== 0 || !envelope.data) return null;
      return envelope.data;
    } catch {
      // Legacy standalone (no state backend) has no status endpoint; the
      // runner falls back to a fixed grace wait.
      return null;
    }
  }

  async recall(query: string, sessionKey: string): Promise<RecallResult> {
    const res = await this.post<{
      context: string;
      strategy?: string;
      memory_count?: number;
      code?: number;
      message?: string;
    }>("/recall", { query, session_key: sessionKey });
    return {
      context: res.context ?? "",
      strategy: res.strategy,
      memoryCount: res.memory_count ?? 0,
      code: res.code ?? 0,
      message: res.message,
    };
  }

  async countL1(): Promise<number | null> {
    try {
      const envelope = await this.post<{ code: number; data?: { total?: number } }>(
        "/v3/atomic/count",
        {},
      );
      if (envelope.code !== 0) return null;
      return envelope.data?.total ?? null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      this.child?.once("exit", () => resolve());
    });
    this.child.kill("SIGTERM");
    // SIGTERM is best-effort on Windows; escalate if the process lingers.
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        if (this.child && this.child.exitCode === null) this.child.kill("SIGKILL");
        resolve();
      }, 5000),
    );
    await Promise.race([exited, timeout]);
    await exited.catch(() => {});
  }
}

// ============================
// Spawning a fresh Gateway
// ============================

export interface SpawnOptions {
  /** MemoryCore package root (cwd for the child process). */
  memoryCoreDir: string;
  /** Per-conversation run directory; data + config land here. */
  runDir: string;
  conversationId: string;
  port: number;
  llm: { baseUrl: string; apiKey: string; model: string };
  /** Extra YAML appended verbatim (advanced overrides). */
  verbose: boolean;
}

/**
 * Pipeline timing tuned for evaluation: low L1 threshold and short L2/L3
 * cascade delays so a run settles in seconds instead of the production
 * defaults (10-minute idle timers). Every value is recorded in the report
 * via the generated config file.
 */
export function buildEvalGatewayConfig(opts: {
  port: number;
  dataDir: string;
  llm: { baseUrl: string; apiKey: string; model: string };
}): string {
  // YAML written explicitly (no yaml dep needed for emit) — keep it simple
  // and greppable in the run directory.
  return [
    "# Generated by scripts/eval-memory — evaluation-tuned standalone Gateway config.",
    "deployMode: standalone",
    'stateBackend: "local"',
    "",
    "server:",
    `  port: ${opts.port}`,
    '  host: "127.0.0.1"',
    "",
    "data:",
    `  baseDir: ${JSON.stringify(opts.dataDir)}`,
    "",
    "llm:",
    `  baseUrl: ${JSON.stringify(opts.llm.baseUrl)}`,
    `  apiKey: ${JSON.stringify(opts.llm.apiKey)}`,
    `  model: ${JSON.stringify(opts.llm.model)}`,
    "  maxTokens: 4096",
    "  timeoutMs: 120000",
    "",
    "memory:",
    "  capture:",
    "    enabled: true",
    "  extraction:",
    "    enabled: true",
    "    enableDedup: true",
    "    maxMemoriesPerSession: 50",
    "  persona:",
    "    triggerEveryN: 10",
    "  pipeline:",
    "    everyNConversations: 3",
    "    enableWarmup: true",
    "    l1IdleTimeoutSeconds: 5",
    "    l2DelayAfterL1Seconds: 3",
    "    l2MinIntervalSeconds: 5",
    "    l2MaxIntervalSeconds: 60",
    "  recall:",
    "    enabled: true",
    "    maxResults: 10",
    "    scoreThreshold: 0.3",
    '    strategy: "keyword"',
    "    timeoutMs: 10000",
    '  storeBackend: "sqlite"',
    "  embedding:",
    '    provider: "none"',
    "  bm25:",
    "    enabled: true",
    '    language: "en"',
    "",
  ].join("\n");
}

export async function spawnEvalGateway(opts: SpawnOptions): Promise<HttpEvalGateway> {
  const dataDir = join(opts.runDir, "data", sanitize(opts.conversationId));
  const configPath = join(opts.runDir, "config", `${sanitize(opts.conversationId)}.yaml`);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(opts.runDir, "config"), { recursive: true });
  writeFileSync(
    configPath,
    buildEvalGatewayConfig({ port: opts.port, dataDir, llm: opts.llm }),
    "utf8",
  );

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/gateway/server.ts"],
    {
      cwd: opts.memoryCoreDir,
      env: {
        ...process.env,
        TDAI_GATEWAY_CONFIG: configPath,
        TDAI_DATA_DIR: dataDir,
        // Ensure a stray env key can't force service mode or remote stores.
        TDAI_DEPLOY_MODE: "standalone",
        STATE_BACKEND: "local",
      },
      stdio: opts.verbose ? "inherit" : ["ignore", "pipe", "pipe"],
    },
  );

  // Keep the last chunk of output around for startup failure diagnostics.
  let recentOutput = "";
  if (!opts.verbose) {
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        recentOutput = (recentOutput + chunk.toString()).slice(-4000);
      });
    }
  }

  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const gateway = new HttpEvalGateway({ baseUrl }, child);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `${TAG} Gateway exited during startup (code ${child.exitCode}).\n${recentOutput}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return gateway;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  await gateway.close();
  throw new Error(`${TAG} Gateway did not become healthy within 90s.\n${recentOutput}`);
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
