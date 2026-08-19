import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayClient } from "./gateway-client.js";
import type { AdapterLogger } from "./types.js";

interface CommandSpec {
  command: string;
  args: string[];
  cwd?: string;
}

type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface GatewaySupervisorOptions {
  client: GatewayClient;
  gatewayUrl: string;
  gatewayCommand?: string;
  logDir: string;
  startupTimeoutMs: number;
  enabled: boolean;
  logger: AdapterLogger;
  spawnImpl?: SpawnImpl;
  moduleUrl?: string;
}

function parseCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const char of value.trim()) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("Gateway command contains an unterminated quote.");
  if (current) parts.push(current);
  return parts;
}

export class GatewaySupervisor {
  private child?: ChildProcess;
  private ownsChild = false;
  private startPromise?: Promise<boolean>;
  private readonly spawnImpl: SpawnImpl;

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
    return Boolean(
      this.child && this.child.exitCode === null && !this.child.killed,
    );
  }

  ensureRunning(): Promise<boolean> {
    if (!this.options.enabled) return this.isRunning();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.ensureRunningInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || !this.ownsChild) return;
    this.ownsChild = false;
    if (child.exitCode !== null || child.killed) return;

    this.signalChild(child, "SIGTERM");
    if (await this.waitForExit(child, 10_000)) return;

    if (process.platform === "win32" && child.pid) {
      await new Promise<void>((resolveDone) => {
        const killer = spawn(
          "taskkill",
          ["/F", "/T", "/PID", String(child.pid)],
          {
            windowsHide: true,
            stdio: "ignore",
          },
        );
        killer.once("exit", () => resolveDone());
        killer.once("error", () => resolveDone());
      });
      return;
    }
    this.signalChild(child, "SIGKILL");
    await this.waitForExit(child, 5_000);
  }

  private async ensureRunningInternal(): Promise<boolean> {
    if (await this.isRunning()) return true;
    if (this.isProcessAlive()) return this.waitForHealth();

    const spec = this.discoverCommand();
    if (!spec) {
      this.options.logger.warn(
        "Gateway is unavailable and no start command could be discovered.",
      );
      return false;
    }

    mkdirSync(this.options.logDir, { recursive: true });
    const stdoutFd = openSync(
      join(this.options.logDir, "gateway.stdout.log"),
      "a",
    );
    const stderrFd = openSync(
      join(this.options.logDir, "gateway.stderr.log"),
      "a",
    );
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
        if (code !== 0 && code !== null) {
          this.options.logger.warn(`Gateway child exited with code ${code}.`);
        }
      });
      this.child.once("error", (error) => {
        this.options.logger.error(`Gateway child failed: ${error.message}`);
      });
    } catch (error) {
      this.child = undefined;
      this.ownsChild = false;
      this.options.logger.error(
        `Failed to start Gateway: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }

    return this.waitForHealth();
  }

  private discoverCommand(): CommandSpec | undefined {
    if (this.options.gatewayCommand?.trim()) {
      const parts = parseCommandLine(this.options.gatewayCommand);
      if (parts.length === 0) return undefined;
      return { command: parts[0]!, args: parts.slice(1) };
    }

    const moduleUrl = this.options.moduleUrl ?? import.meta.url;
    const integrationDir = resolve(dirname(fileURLToPath(moduleUrl)), "..");
    const repositoryRoot = resolve(integrationDir, "..", "..");
    const candidates = [
      join(repositoryRoot, "src", "gateway", "server.ts"),
      join(
        process.env.HOME ?? process.env.USERPROFILE ?? "",
        ".memory-tencentdb",
        "tdai-memory-openclaw-plugin",
        "src",
        "gateway",
        "server.ts",
      ),
    ].filter(Boolean);

    const entry = candidates.find((candidate) => existsSync(candidate));
    if (!entry) return undefined;
    return {
      command: process.execPath,
      args: ["--import", "tsx/esm", entry],
      cwd: resolve(dirname(entry), "..", ".."),
    };
  }

  private gatewayEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    try {
      const url = new URL(this.options.gatewayUrl);
      if (!env.TDAI_GATEWAY_HOST) env.TDAI_GATEWAY_HOST = url.hostname;
      if (!env.TDAI_GATEWAY_PORT) {
        env.TDAI_GATEWAY_PORT =
          url.port || (url.protocol === "https:" ? "443" : "80");
      }
    } catch {
      // Config validation already reports invalid URLs.
    }
    return env;
  }

  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) return false;
      if (await this.isRunning()) return true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    this.options.logger.error(
      "Gateway did not become healthy before the startup timeout.",
    );
    return false;
  }

  private waitForExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    if (child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit(false), timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit(true);
      });
    });
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back when the child was not placed in its own process group.
      }
    }
    child.kill(signal);
  }
}
