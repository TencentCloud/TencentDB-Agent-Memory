/**
 * LifecycleManager — Manages adapter lifecycle (install, upgrade, uninstall, health checks).
 *
 * Features:
 * - Lifecycle state machine
 * - Install/uninstall hooks
 * - Health check framework
 * - Version management
 */

import type { Logger } from "../../core/types.js";

// ============================
// Lifecycle states
// ============================

export enum LifecycleState {
  /** Not installed */
  NOT_INSTALLED = "not_installed",
  /** Installation in progress */
  INSTALLING = "installing",
  /** Installed but not started */
  INSTALLED = "installed",
  /** Starting up */
  STARTING = "starting",
  /** Running */
  RUNNING = "running",
  /** Stopping */
  STOPPING = "stopping",
  /** Stopped */
  STOPPED = "stopped",
  /** Upgrading */
  UPGRADING = "upgrading",
  /** Uninstalling */
  UNINSTALLING = "uninstalling",
  /** Uninstalled */
  UNINSTALLED = "uninstalled",
  /** Error state */
  ERROR = "error",
}

// ============================
// Health check types
// ============================

export interface HealthCheckResult {
  /** Whether the check passed */
  healthy: boolean;
  /** Check name */
  name: string;
  /** Time taken in ms */
  durationMs: number;
  /** Check details */
  details?: Record<string, unknown>;
  /** Error message if failed */
  error?: string;
}

export interface HealthCheck {
  /** Unique check name */
  name: string;
  /** Check function */
  check: () => Promise<HealthCheckResult>;
  /** Whether this check is critical */
  critical?: boolean;
  /** Check timeout in ms */
  timeoutMs?: number;
}

// ============================
// Lifecycle hooks
// ============================

export interface LifecycleHooks {
  /** Called before installation */
  onBeforeInstall?: () => void | Promise<void>;
  /** Called after installation */
  onAfterInstall?: (success: boolean) => void | Promise<void>;
  /** Called before uninstallation */
  onBeforeUninstall?: () => void | Promise<void>;
  /** Called after uninstallation */
  onAfterUninstall?: (success: boolean) => void | Promise<void>;
  /** Called before upgrade */
  onBeforeUpgrade?: (fromVersion: string, toVersion: string) => void | Promise<void>;
  /** Called after upgrade */
  onAfterUpgrade?: (fromVersion: string, toVersion: string, success: boolean) => void | Promise<void>;
  /** Called on state change */
  onStateChange?: (from: LifecycleState, to: LifecycleState) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

// ============================
// Lifecycle manager options
// ============================

export interface LifecycleManagerOptions {
  /** Platform identifier */
  platformId: string;
  /** Logger instance */
  logger?: Logger;
  /** Lifecycle hooks */
  hooks?: LifecycleHooks;
  /** Custom health checks */
  healthChecks?: HealthCheck[];
  /** Health check interval in ms (0 = disabled) */
  healthCheckIntervalMs?: number;
}

// ============================
// DefaultLifecycleManager
// ============================

export class DefaultLifecycleManager implements LifecycleManager {
  private platformId: string;
  private logger?: Logger;
  private state: LifecycleState = LifecycleState.NOT_INSTALLED;
  private previousState: LifecycleState | undefined;
  private version: string | undefined;
  private healthChecks: HealthCheck[] = [];
  private healthCheckIntervalMs: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  private hooks: LifecycleHooks;
  private lastHealthCheck: HealthCheckResult[] = [];
  private lastHealthCheckTime: number = 0;

  constructor(opts: LifecycleManagerOptions) {
    this.platformId = opts.platformId;
    this.logger = opts.logger;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 0;
    this.hooks = opts.hooks ?? {};

    // Register default health checks
    this.registerDefaultHealthChecks();

    // Register custom health checks
    if (opts.healthChecks) {
      for (const check of opts.healthChecks) {
        this.registerHealthCheck(check);
      }
    }
  }

  // ============================
  // State management
  // ============================

  /** @implements LifecycleManager */
  getState(): LifecycleState {
    return this.state;
  }

  /** @implements LifecycleManager */
  getVersion(): string | undefined {
    return this.version;
  }

  /** @implements LifecycleManager */
  setVersion(version: string): void {
    this.version = version;
    this.logger?.debug?.(`[${this.platformId}] Version set to ${version}`);
  }

  /** @implements LifecycleManager */
  getPreviousState(): LifecycleState | undefined {
    return this.previousState;
  }

  /** @implements LifecycleManager */
  isInState(...states: LifecycleState[]): boolean {
    return states.includes(this.state);
  }

  /** @implements LifecycleManager */
  canTransitionTo(targetState: LifecycleState): boolean {
    const validTransitions: Record<LifecycleState, LifecycleState[]> = {
      [LifecycleState.NOT_INSTALLED]: [LifecycleState.INSTALLING],
      [LifecycleState.INSTALLED]: [LifecycleState.INSTALLING, LifecycleState.STARTING],
      [LifecycleState.INSTALLING]: [LifecycleState.INSTALLED, LifecycleState.ERROR],
      [LifecycleState.STARTING]: [LifecycleState.RUNNING, LifecycleState.ERROR],
      [LifecycleState.RUNNING]: [LifecycleState.STOPPING, LifecycleState.UPGRADING],
      [LifecycleState.STOPPING]: [LifecycleState.STOPPED, LifecycleState.ERROR],
      [LifecycleState.STOPPED]: [LifecycleState.STARTING, LifecycleState.UNINSTALLING],
      [LifecycleState.UPGRADING]: [LifecycleState.RUNNING, LifecycleState.ERROR],
      [LifecycleState.UNINSTALLING]: [LifecycleState.UNINSTALLED, LifecycleState.ERROR],
      [LifecycleState.UNINSTALLED]: [LifecycleState.INSTALLING],
      [LifecycleState.ERROR]: [LifecycleState.STOPPING, LifecycleState.UNINSTALLING, LifecycleState.INSTALLING],
    };

    return validTransitions[this.state]?.includes(targetState) ?? false;
  }

  // ============================
  // Lifecycle operations
  // ============================

  /** @implements LifecycleManager */
  async install(): Promise<boolean> {
    if (!this.canTransitionTo(LifecycleState.INSTALLING)) {
      this.logger?.warn?.(`Cannot install from state: ${this.state}`);
      return false;
    }

    this.transitionTo(LifecycleState.INSTALLING);

    try {
      await this.hooks.onBeforeInstall?.();

      // Platform-specific install logic should be added by subclass
      this.logger?.info?.(`Installing ${this.platformId}...`);

      // Simulate installation
      await this.sleep(100);

      this.transitionTo(LifecycleState.INSTALLED);
      await this.hooks.onAfterInstall?.(true);

      this.logger?.info?.(`Installation completed successfully`);
      return true;
    } catch (error) {
      this.transitionTo(LifecycleState.ERROR);
      this.hooks.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.logger?.error?.(`Installation failed: ${error}`);
      await this.hooks.onAfterInstall?.(false);
      return false;
    }
  }

  /** @implements LifecycleManager */
  async uninstall(): Promise<boolean> {
    if (!this.canTransitionTo(LifecycleState.UNINSTALLING)) {
      this.logger?.warn?.(`Cannot uninstall from state: ${this.state}`);
      return false;
    }

    this.transitionTo(LifecycleState.UNINSTALLING);

    try {
      await this.hooks.onBeforeUninstall?.();

      this.logger?.info?.(`Uninstalling ${this.platformId}...`);

      // Stop health checks
      this.stopHealthCheckTimer();

      // Platform-specific uninstall logic
      await this.sleep(100);

      this.transitionTo(LifecycleState.UNINSTALLED);
      await this.hooks.onAfterUninstall?.(true);

      this.logger?.info?.(`Uninstallation completed successfully`);
      return true;
    } catch (error) {
      this.transitionTo(LifecycleState.ERROR);
      this.hooks.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.logger?.error?.(`Uninstallation failed: ${error}`);
      await this.hooks.onAfterUninstall?.(false);
      return false;
    }
  }

  /** @implements LifecycleManager */
  async start(): Promise<boolean> {
    if (!this.canTransitionTo(LifecycleState.STARTING)) {
      this.logger?.warn?.(`Cannot start from state: ${this.state}`);
      return false;
    }

    this.transitionTo(LifecycleState.STARTING);

    try {
      this.logger?.info?.(`Starting ${this.platformId}...`);

      // Start health checks if interval is configured
      if (this.healthCheckIntervalMs > 0) {
        this.startHealthCheckTimer();
      }

      this.transitionTo(LifecycleState.RUNNING);
      this.logger?.info?.(`Started successfully`);
      return true;
    } catch (error) {
      this.transitionTo(LifecycleState.ERROR);
      this.hooks.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.logger?.error?.(`Start failed: ${error}`);
      return false;
    }
  }

  /** @implements LifecycleManager */
  async stop(): Promise<boolean> {
    if (!this.canTransitionTo(LifecycleState.STOPPING)) {
      this.logger?.warn?.(`Cannot stop from state: ${this.state}`);
      return false;
    }

    this.transitionTo(LifecycleState.STOPPING);

    try {
      this.logger?.info?.(`Stopping ${this.platformId}...`);

      // Stop health checks
      this.stopHealthCheckTimer();

      this.transitionTo(LifecycleState.STOPPED);
      this.logger?.info?.(`Stopped successfully`);
      return true;
    } catch (error) {
      this.transitionTo(LifecycleState.ERROR);
      this.hooks.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.logger?.error?.(`Stop failed: ${error}`);
      return false;
    }
  }

  /** @implements LifecycleManager */
  async upgrade(fromVersion: string, toVersion: string): Promise<boolean> {
    this.transitionTo(LifecycleState.UPGRADING);

    try {
      await this.hooks.onBeforeUpgrade?.(fromVersion, toVersion);

      this.logger?.info?.(`Upgrading ${this.platformId} from ${fromVersion} to ${toVersion}...`);

      // Platform-specific upgrade logic
      await this.sleep(100);

      this.version = toVersion;
      this.transitionTo(LifecycleState.RUNNING);
      await this.hooks.onAfterUpgrade?.(fromVersion, toVersion, true);

      this.logger?.info?.(`Upgrade completed successfully`);
      return true;
    } catch (error) {
      this.transitionTo(LifecycleState.ERROR);
      this.hooks.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.logger?.error?.(`Upgrade failed: ${error}`);
      await this.hooks.onAfterUpgrade?.(fromVersion, toVersion, false);
      return false;
    }
  }

  // ============================
  // Health checks
  // ============================

  /** @implements LifecycleManager */
  registerHealthCheck(check: HealthCheck): void {
    this.healthChecks.push(check);
    this.logger?.debug?.(`Health check registered: ${check.name}`);
  }

  /** @implements LifecycleManager */
  unregisterHealthCheck(name: string): boolean {
    const index = this.healthChecks.findIndex(c => c.name === name);
    if (index !== -1) {
      this.healthChecks.splice(index, 1);
      this.logger?.debug?.(`Health check unregistered: ${name}`);
      return true;
    }
    return false;
  }

  /** @implements LifecycleManager */
  async runHealthChecks(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    for (const check of this.healthChecks) {
      const startTime = Date.now();
      try {
        const timeoutPromise = check.timeoutMs
          ? new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Health check timeout")), check.timeoutMs))
          : Promise.resolve();

        const result = await Promise.race([check.check(), timeoutPromise]);

        results.push({
          ...result,
          durationMs: Date.now() - startTime,
        });
      } catch (error) {
        results.push({
          healthy: false,
          name: check.name,
          durationMs: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.lastHealthCheck = results;
    this.lastHealthCheckTime = Date.now();

    return results;
  }

  /** @implements LifecycleManager */
  getLastHealthCheck(): ReadonlyArray<HealthCheckResult> {
    return this.lastHealthCheck;
  }

  /** @implements LifecycleManager */
  isHealthy(): boolean {
    const criticalChecks = this.healthChecks.filter(c => c.critical);
    if (criticalChecks.length === 0) {
      return this.state === LifecycleState.RUNNING;
    }

    return this.lastHealthCheck
      .filter(r => criticalChecks.some(c => c.name === r.name))
      .every(r => r.healthy);
  }

  // ============================
  // Hooks management
  // ============================

  /** @implements LifecycleManager */
  setHooks(hooks: Partial<LifecycleHooks>): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /** @implements LifecycleManager */
  clearHooks(): void {
    this.hooks = {};
  }

  // ============================
  // Cleanup
  // ============================

  /** @implements LifecycleManager */
  dispose(): void {
    this.stopHealthCheckTimer();
    this.healthChecks = [];
    this.logger?.debug?.(`LifecycleManager disposed`);
  }

  // ============================
  // Private helpers
  // ============================

  private transitionTo(newState: LifecycleState): void {
    if (this.state === newState) return;

    const oldState = this.state;
    this.previousState = oldState;
    this.state = newState;

    this.logger?.debug?.(`[${this.platformId}] State transition: ${oldState} -> ${newState}`);
    this.hooks.onStateChange?.(oldState, newState);
  }

  private registerDefaultHealthChecks(): void {
    // Default: check if lifecycle manager is in a running state
    this.registerHealthCheck({
      name: "lifecycle_state",
      critical: true,
      check: async () => ({
        healthy: this.isInState(LifecycleState.RUNNING, LifecycleState.STOPPED),
        name: "lifecycle_state",
        durationMs: 0,
        details: { state: this.state },
      }),
    });
  }

  private startHealthCheckTimer(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.runHealthChecks();
      } catch (error) {
        this.logger?.error?.(`Health check failed: ${error}`);
      }
    }, this.healthCheckIntervalMs);

    this.logger?.debug?.(`Health check timer started (interval: ${this.healthCheckIntervalMs}ms)`);
  }

  private stopHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
      this.logger?.debug?.(`Health check timer stopped`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================
// LifecycleManager interface
// ============================

export interface LifecycleManager {
  /**
   * Get current lifecycle state.
   */
  getState(): LifecycleState;

  /**
   * Get current version.
   */
  getVersion(): string | undefined;

  /**
   * Set version.
   */
  setVersion(version: string): void;

  /**
   * Get previous state.
   */
  getPreviousState(): LifecycleState | undefined;

  /**
   * Check if in specific state(s).
   */
  isInState(...states: LifecycleState[]): boolean;

  /**
   * Check if transition to target state is valid.
   */
  canTransitionTo(targetState: LifecycleState): boolean;

  /**
   * Install the plugin.
   */
  install(): Promise<boolean>;

  /**
   * Uninstall the plugin.
   */
  uninstall(): Promise<boolean>;

  /**
   * Start the plugin.
   */
  start(): Promise<boolean>;

  /**
   * Stop the plugin.
   */
  stop(): Promise<boolean>;

  /**
   * Upgrade from one version to another.
   */
  upgrade(fromVersion: string, toVersion: string): Promise<boolean>;

  /**
   * Register a health check.
   */
  registerHealthCheck(check: HealthCheck): void;

  /**
   * Unregister a health check.
   */
  unregisterHealthCheck(name: string): boolean;

  /**
   * Run all health checks.
   */
  runHealthChecks(): Promise<HealthCheckResult[]>;

  /**
   * Get last health check results.
   */
  getLastHealthCheck(): ReadonlyArray<HealthCheckResult>;

  /**
   * Check if overall health is good.
   */
  isHealthy(): boolean;

  /**
   * Set lifecycle hooks.
   */
  setHooks(hooks: Partial<LifecycleHooks>): void;

  /**
   * Clear all hooks.
   */
  clearHooks(): void;

  /**
   * Dispose resources.
   */
  dispose(): void;
}
