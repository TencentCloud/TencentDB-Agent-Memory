import { createHash } from "node:crypto";
import { watchFile, unwatchFile } from "node:fs";
import { resolve } from "node:path";
import { buildConfig, type CliOverrides } from "./config.js";
import { log } from "./report/log.js";
import type { ProxyConfig } from "./types.js";

export type ConfigProvider = () => ProxyConfig;

export interface ConfigReloadEvent {
  version: number;
  hash: string;
  changed: string[];
  restartRequired: string[];
}

export interface ConfigRuntimeOptions {
  overrides: CliOverrides;
  initial: ProxyConfig;
  onApply?: (
    previous: ProxyConfig,
    next: ProxyConfig,
    event: ConfigReloadEvent,
  ) => void;
  watchIntervalMs?: number;
  debounceMs?: number;
}

/** Only the model pricing catalog is allowed to change without a restart. */
const DYNAMIC_SECTIONS = ["creditPricing"] as const;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(json(value)).digest("hex").slice(0, 16);
}

function modelSlice(config: ProxyConfig): Record<string, unknown> {
  return {
    creditPricing: config.creditPricing,
  };
}

function finiteNonNegative(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}

/** Validate only the sections this runtime is authorized to publish. */
export function validateDynamicModelConfig(config: ProxyConfig): void {
  if (!Array.isArray(config.creditPricing.models)) {
    throw new Error("creditPricing.models must be an array");
  }
  for (const [index, model] of config.creditPricing.models.entries()) {
    if (!model || typeof model.name !== "string" || !model.name.trim()) {
      throw new Error(`creditPricing.models[${index}].name must be non-empty`);
    }
    if (typeof model.modelName !== "string" || !model.modelName.trim()) {
      throw new Error(`creditPricing.models[${index}].modelName must be non-empty`);
    }
    for (const field of ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const) {
      finiteNonNegative(model[field], `creditPricing.models[${index}].${field}`);
    }
  }
}

/**
 * Publish only model-service sections. Everything else remains pinned to the
 * startup snapshot and is reported as restart-required.
 */
export function mergeDynamicModelConfig(
  current: ProxyConfig,
  candidate: ProxyConfig,
): { next: ProxyConfig; restartRequired: string[] } {
  const dynamic = new Set<string>(DYNAMIC_SECTIONS);
  const restartRequired = (Object.keys(candidate) as Array<keyof ProxyConfig>)
    .filter((key) => !dynamic.has(String(key)))
    .filter((key) => json(current[key]) !== json(candidate[key]))
    .map(String);

  return {
    next: {
      ...current,
      creditPricing: candidate.creditPricing,
    },
    restartRequired: [...new Set(restartRequired)].sort(),
  };
}

export class DynamicConfigRuntime {
  private current: ProxyConfig;
  private version = 1;
  private hash: string;
  private timer: NodeJS.Timeout | null = null;
  private reloadChain: Promise<boolean> = Promise.resolve(false);
  private watching = false;
  readonly configPath: string;

  constructor(private readonly options: ConfigRuntimeOptions) {
    validateDynamicModelConfig(options.initial);
    this.current = options.initial;
    this.hash = shortHash(modelSlice(options.initial));
    this.configPath = resolve(options.overrides.configFile || "config.yaml");
  }

  getSnapshot = (): ProxyConfig => this.current;

  getInfo(): { version: number; hash: string } {
    return { version: this.version, hash: this.hash };
  }

  reload(): Promise<boolean> {
    this.reloadChain = this.reloadChain.then(() => this.reloadOnce(), () => this.reloadOnce());
    return this.reloadChain;
  }

  private async reloadOnce(): Promise<boolean> {
    try {
      const candidate = buildConfig(this.options.overrides, { strict: true });
      validateDynamicModelConfig(candidate);
      const { next, restartRequired } = mergeDynamicModelConfig(this.current, candidate);
      const nextHash = shortHash(modelSlice(next));
      if (nextHash === this.hash) {
        if (restartRequired.length > 0) {
          log.warn("config.reload.restart_required", {
            version: this.version,
            fields: restartRequired,
          });
        }
        return false;
      }

      const changed = DYNAMIC_SECTIONS
        .filter((key) => json(this.current[key]) !== json(next[key]))
        .map(String);
      const event: ConfigReloadEvent = {
        version: this.version + 1,
        hash: nextHash,
        changed,
        restartRequired,
      };
      this.options.onApply?.(this.current, next, event);
      this.current = next;
      this.version = event.version;
      this.hash = nextHash;
      log.info("config.reload.applied", { ...event });
      if (restartRequired.length > 0) {
        log.warn("config.reload.restart_required", {
          version: event.version,
          fields: restartRequired,
        });
      }
      return true;
    } catch (err: unknown) {
      log.error("config.reload.rejected", {
        configPath: this.configPath,
        version: this.version,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  start(): void {
    if (this.watching) return;
    this.watching = true;
    const interval = Math.max(250, this.options.watchIntervalMs ?? 60_000);
    const debounce = Math.max(0, this.options.debounceMs ?? 200);
    watchFile(this.configPath, { interval }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.reload();
      }, debounce);
    });
    log.info("config.reload.watching", {
      configPath: this.configPath,
      version: this.version,
      hash: this.hash,
    });
  }

  stop(): void {
    if (!this.watching) return;
    this.watching = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    unwatchFile(this.configPath);
  }
}
