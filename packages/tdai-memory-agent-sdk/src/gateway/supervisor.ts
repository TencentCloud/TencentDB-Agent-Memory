import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { GatewayClient } from "./client.js";
import {
  ensureDefaultGatewayConfig,
  resolveGatewayDefaults,
  validateExistingGatewayConfig,
} from "./config.js";
import type {
  GatewayEndpoints,
  GatewaySupervisorLike,
  GatewaySupervisorOptions,
  Logger,
  MemoryPaths,
} from "../types.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class GatewaySupervisor implements GatewaySupervisorLike {
  readonly endpoints: GatewayEndpoints;
  readonly paths: MemoryPaths;

  private readonly options: Required<Pick<
    GatewaySupervisorOptions,
    "agentSdkName" | "startupTimeoutMs" | "healthPollMs" | "requestTimeoutMs" | "autoStart"
  >> & Omit<GatewaySupervisorOptions, "agentSdkName" | "startupTimeoutMs" | "healthPollMs" | "requestTimeoutMs" | "autoStart">;

  private readonly gatewayCwd: string;
  private readonly host: string;
  private readonly port: number;
  private readonly client: GatewayClient;
  private readonly logger?: Logger;
  private process: ChildProcess | null = null;
  private startedBySupervisor = false;
  private startError: Error | null = null;

  constructor(options: GatewaySupervisorOptions) {
    const defaults = resolveGatewayDefaults(options);
    this.paths = defaults.paths;
    this.endpoints = {
      gatewayUrl: defaults.gatewayUrl,
      apiKey: options.apiKey,
    };
    this.gatewayCwd = defaults.gatewayCwd;
    this.host = defaults.host;
    this.port = defaults.port;
    this.logger = options.logger;
    this.options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      healthPollMs: options.healthPollMs ?? DEFAULT_HEALTH_POLL_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      autoStart: options.autoStart ?? true,
    };
    this.client = new GatewayClient({
      gatewayUrl: this.endpoints.gatewayUrl,
      apiKey: this.endpoints.apiKey,
      timeoutMs: Math.min(this.options.requestTimeoutMs, 3_000),
    });
  }

  async ensureRunning(): Promise<void> {
    this.prepareRuntime();
    this.validateOrCreateConfig();

    if (await this.isHealthy()) return;
    if (!this.options.autoStart && !this.options.gatewayCommand) {
      throw new Error(
        `TDAI Gateway is not reachable at ${this.endpoints.gatewayUrl}. ` +
        "Set autoStart=true, provide gatewayCommand, or start the Gateway manually.",
      );
    }

    this.startProcess();
    await this.waitForHealth();
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (!child || !this.startedBySupervisor) return;
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      const done = once(resolve);
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore cleanup failures
        }
        done();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        done();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        done();
      }
    });
  }

  private prepareRuntime(): void {
    fs.mkdirSync(this.paths.rootDir, { recursive: true });
    fs.mkdirSync(this.paths.dataDir, { recursive: true });
    fs.mkdirSync(this.paths.logDir, { recursive: true });
    fs.mkdirSync(this.paths.runtimeDir, { recursive: true });
  }

  private validateOrCreateConfig(): void {
    const validation = validateExistingGatewayConfig({
      configPath: this.paths.configPath,
      dataDir: this.paths.dataDir,
      port: this.port,
    });
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    ensureDefaultGatewayConfig({
      configPath: this.paths.configPath,
      dataDir: this.paths.dataDir,
      host: this.host,
      port: this.port,
      apiKey: this.endpoints.apiKey,
    });
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const result = await this.client.health();
      return result.status === "ok" || result.status === "degraded";
    } catch {
      return false;
    }
  }

  private startProcess(): void {
    if (this.process && this.process.exitCode === null && this.process.signalCode === null) return;

    const command = this.resolveCommand();
    const stdoutPath = path.join(this.paths.logDir, "gateway.stdout.log");
    const stderrPath = path.join(this.paths.logDir, "gateway.stderr.log");
    const stdout = fs.openSync(stdoutPath, "a");
    const stderr = fs.openSync(stderrPath, "a");
    const env = {
      ...process.env,
      TDAI_GATEWAY_URL: this.endpoints.gatewayUrl,
      TDAI_GATEWAY_HOST: this.host,
      TDAI_GATEWAY_PORT: String(this.port),
      TDAI_GATEWAY_CONFIG: this.paths.configPath,
      TDAI_DATA_DIR: this.paths.dataDir,
      ...(this.endpoints.apiKey ? { TDAI_GATEWAY_API_KEY: this.endpoints.apiKey } : {}),
    };

    this.logger?.info?.(`Starting TDAI Gateway: ${command.join(" ")}`);
    this.startError = null;
    this.process = spawn(command[0], command.slice(1), {
      cwd: this.gatewayCwd,
      env,
      stdio: ["ignore", stdout, stderr],
      detached: process.platform !== "win32",
    });
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    this.startedBySupervisor = true;

    fs.writeFileSync(path.join(this.paths.runtimeDir, "gateway.pid"), String(this.process.pid ?? ""), "utf-8");
    fs.writeFileSync(
      path.join(this.paths.runtimeDir, "gateway-owned.json"),
      JSON.stringify({
        pid: this.process.pid,
        gatewayUrl: this.endpoints.gatewayUrl,
        startedAt: new Date().toISOString(),
        command,
      }, null, 2),
      "utf-8",
    );

    this.process.once("error", (error) => {
      this.startError = error;
      this.logger?.error?.(`TDAI Gateway child failed to start: ${error.message}`);
    });
    this.process.once("exit", (code, signal) => {
      this.logger?.debug?.(`TDAI Gateway child exited code=${code ?? ""} signal=${signal ?? ""}`);
    });
  }

  private resolveCommand(): string[] {
    if (Array.isArray(this.options.gatewayCommand)) return this.options.gatewayCommand;
    if (this.options.gatewayCommand) return splitCommand(this.options.gatewayCommand);
    return ["node", "--import", "tsx", path.join(this.gatewayCwd, "src", "gateway", "server.ts")];
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.startError) {
        throw new Error(`TDAI Gateway failed to start: ${this.startError.message}`);
      }
      if (await this.isHealthy()) return;
      const child = this.process;
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(
          `TDAI Gateway exited before becoming healthy ` +
          `(code=${child.exitCode ?? ""}, signal=${child.signalCode ?? ""}). ` +
          `See logs in ${this.paths.logDir}.`,
        );
      }
      await delay(this.options.healthPollMs);
    }
    throw new Error(
      `TDAI Gateway did not become healthy at ${this.endpoints.gatewayUrl} ` +
      `within ${this.options.startupTimeoutMs}ms. See logs in ${this.paths.logDir}.`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

function splitCommand(command: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error(`Unterminated quote in gatewayCommand: ${command}`);
  if (current) result.push(current);
  if (result.length === 0) throw new Error("gatewayCommand is empty");
  return result;
}
