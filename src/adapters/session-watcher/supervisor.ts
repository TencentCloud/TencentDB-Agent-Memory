/**
 * Gateway Supervisor — manages TDAI Gateway process lifecycle.
 *
 * Mirrors the Hermes supervisor.py pattern in TypeScript:
 *  1. Health check — if Gateway is already running, return immediately
 *  2. Spawn — if not running, spawn as child process
 *  3. Wait — poll /health until ready (30s timeout)
 *  4. Cleanup — on process exit, SIGTERM → wait 10s → SIGKILL
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TdaiMcpConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class GatewaySupervisor {
  private config: TdaiMcpConfig;
  private child?: ChildProcess;
  private shutdownRequested = false;

  constructor(config: TdaiMcpConfig) {
    this.config = config;
  }

  async ensureRunning(): Promise<void> {
    const healthy = await this.checkHealth();
    if (healthy) {
      process.stderr.write("[gateway-supervisor] Gateway already healthy\n");
      return;
    }

    process.stderr.write(
      "[gateway-supervisor] Gateway not reachable, starting...\n",
    );
    await this.spawn();
    await this.waitForReady();
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    this.shutdownRequested = true;

    process.stderr.write("[gateway-supervisor] Shutting down Gateway...\n");
    this.child.kill("SIGTERM");

    const graceful = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      this.child!.on("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    if (!graceful) {
      process.stderr.write(
        "[gateway-supervisor] Gateway did not exit, sending SIGKILL\n",
      );
      this.child.kill("SIGKILL");
    } else {
      process.stderr.write("[gateway-supervisor] Gateway exited gracefully\n");
    }
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.gateway.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async spawn(): Promise<void> {
    const projectRoot = path.resolve(__dirname, "..", "..");
    const gatewayPath = path.join(projectRoot, "src", "gateway", "server.ts");

    const env = {
      ...process.env,
      TDAI_GATEWAY_PORT: String(this.config.gateway.port),
    };

    this.child = spawn("npx", ["tsx", gatewayPath], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    this.child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trim();
      for (const line of lines.split("\n")) {
        process.stderr.write(`[gateway] ${line}\n`);
      }
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trim();
      for (const line of lines.split("\n")) {
        process.stderr.write(`[gateway:err] ${line}\n`);
      }
    });

    this.child.on("exit", (code) => {
      process.stderr.write(
        `[gateway-supervisor] Gateway exited (code=${code})\n`,
      );
      this.child = undefined;
    });

    const cleanup = () => {
      if (!this.shutdownRequested && this.child) {
        this.child.kill("SIGTERM");
      }
    };
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.checkHealth()) {
        process.stderr.write("[gateway-supervisor] Gateway is ready\n");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("Gateway failed to become healthy within 30 seconds");
  }
}
