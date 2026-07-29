import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { AdapterLogger } from "./types.js";
import { GatewayClient } from "./gateway-client.js";

interface SpawnSpec { command: string; args: string[]; cwd: string }

export interface GatewaySupervisorOptions {
  client: GatewayClient;
  gatewayUrl: string;
  gatewayCommand?: string;
  logDir: string;
  logger: AdapterLogger;
  enabled?: boolean;
  startupTimeoutMs?: number;
  healthIntervalMs?: number;
  cwd?: string;
  spawnImpl?: typeof spawn;
}

export class GatewaySupervisor {
  private child?: ChildProcess;
  private ownsChild = false;
  private startPromise?: Promise<boolean>;
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: GatewaySupervisorOptions) {
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async isRunning(): Promise<boolean> {
    try {
      const health = await this.options.client.health(2_000);
      return health.status === "ok" || health.status === "degraded";
    } catch {
      return false;
    }
  }

  isProcessAlive(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  ensureRunning(): Promise<boolean> {
    if (!this.options.enabled) return this.isRunning();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.ensureRunningInternal().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async ensureRunningInternal(): Promise<boolean> {
    if (await this.isRunning()) return true;
    if (this.isProcessAlive()) return this.waitForHealth();
    const spec = this.discoverCommand();
    if (!spec) {
      this.options.logger.warn("Gateway is unavailable and no start command could be discovered.");
      return false;
    }

    mkdirSync(this.options.logDir, { recursive: true });
    const stdoutFd = openSync(join(this.options.logDir, "gateway.stdout.log"), "a");
    const stderrFd = openSync(join(this.options.logDir, "gateway.stderr.log"), "a");
    try {
      this.child = this.spawnImpl(spec.command, spec.args, {
        cwd: spec.cwd,
        env: this.gatewayEnvironment(),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      this.ownsChild = true;
      this.child.once("exit", (code) => {
        if (code !== 0 && code !== null) this.options.logger.warn(`Gateway child exited with code ${code}.`);
      });
      this.child.once("error", (error) => this.options.logger.error(`Gateway child failed: ${error.message}`));
    } catch (error) {
      this.options.logger.error(`Failed to start Gateway: ${error instanceof Error ? error.message : String(error)}`);
      this.child = undefined;
      this.ownsChild = false;
      return false;
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    return this.waitForHealth();
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || !this.ownsChild) return;
    this.ownsChild = false;
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    const exited = await new Promise<boolean>((resolveExit) => {
      const timer = setTimeout(() => resolveExit(false), 10_000);
      child.once("exit", () => { clearTimeout(timer); resolveExit(true); });
    });
    if (exited) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
      await new Promise<void>((resolveExit) => killer.once("exit", () => resolveExit()));
    } else {
      child.kill("SIGKILL");
    }
  }

  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    const interval = this.options.healthIntervalMs ?? 500;
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) return false;
      if (await this.isRunning()) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, interval));
    }
    this.options.logger.warn("Gateway did not become healthy before the startup timeout.");
    return false;
  }

  private gatewayEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    try {
      const url = new URL(this.options.gatewayUrl);
      env.TDAI_GATEWAY_HOST ??= url.hostname;
      env.TDAI_GATEWAY_PORT ??= url.port || "8420";
    } catch {
      // The client will report an invalid URL; do not invent child settings.
    }
    return env;
  }

  private discoverCommand(): SpawnSpec | undefined {
    const cwd = resolve(this.options.cwd ?? process.cwd());
    if (this.options.gatewayCommand) {
      return process.platform === "win32"
        ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", this.options.gatewayCommand], cwd }
        : { command: "/bin/sh", args: ["-lc", this.options.gatewayCommand], cwd };
    }

    const integrationDir = dirname(fileURLToPath(import.meta.url));
    const packageRoot = resolve(integrationDir, "..", "..", "..");
    const roots = [
      packageRoot,
      resolve(homedir(), ".memory-tencentdb", "tdai-memory-openclaw-plugin"),
      cwd,
      resolve(cwd, "TencentDB-Agent-Memory"),
    ];
    for (const root of roots) {
      const serverPath = join(root, "src", "gateway", "server.ts");
      try {
        if (basename(serverPath) === "server.ts" && requireExists(serverPath)) {
          return { command: process.execPath, args: ["--import", "tsx/esm", serverPath], cwd: root };
        }
      } catch {
        // Continue to the next documented discovery location.
      }
    }
    return undefined;
  }
}

function requireExists(path: string): boolean {
  return existsSync(path);
}
