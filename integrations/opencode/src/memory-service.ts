import { CircuitBreaker } from "./circuit-breaker.js";
import type { GatewayClient } from "./gateway-client.js";
import type { GatewaySupervisor } from "./gateway-supervisor.js";

const RECOVER_COOLDOWN_MS = 15_000;

export class MemoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryUnavailableError";
  }
}

export class MemoryService {
  private readonly breaker = new CircuitBreaker();
  private lastRecoverAttemptMs = 0;

  constructor(
    readonly client: GatewayClient,
    private readonly supervisor: GatewaySupervisor,
  ) {}

  async health(): Promise<Awaited<ReturnType<GatewayClient["health"]>>> {
    try {
      const result = await this.client.health();
      this.breaker.success();
      return result;
    } catch (error) {
      this.breaker.failure();
      throw error;
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.breaker.isOpen()) {
      throw new MemoryUnavailableError("circuit breaker is open");
    }
    if (!(await this.ensureAvailable())) {
      this.breaker.failure();
      throw new MemoryUnavailableError("Gateway is not connected");
    }
    try {
      const result = await operation();
      this.breaker.success();
      return result;
    } catch (error) {
      this.breaker.failure();
      throw error;
    }
  }

  private async ensureAvailable(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastRecoverAttemptMs < RECOVER_COOLDOWN_MS) {
      return this.supervisor.isRunning();
    }
    this.lastRecoverAttemptMs = now;
    return this.supervisor.ensureRunning();
  }
}
