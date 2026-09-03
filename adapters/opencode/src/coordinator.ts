import type { AdapterConfig } from "./config.js";
import { MemoryGatewayClient } from "./client.js";
import { completedTurns } from "./capture.js";
import { DeliveryStore } from "./state.js";
import type { OpenCodeMessage, PendingDelivery } from "./types.js";

export type AdapterLogger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => Promise<void>;

export class TurnCoordinator {
  private readonly sessionChains = new Map<string, Promise<void>>();
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AdapterConfig,
    readonly gateway: MemoryGatewayClient,
    private readonly store: DeliveryStore,
    private readonly log: AdapterLogger,
  ) {}

  private enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.sessionChains.get(sessionId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(() => undefined, () => undefined);
    this.sessionChains.set(sessionId, tail);
    return current.finally(() => {
      // Do not delete a newer operation that was queued for this session while
      // the current one was still in flight.
      if (this.sessionChains.get(sessionId) === tail) this.sessionChains.delete(sessionId);
    });
  }

  private async deliver(record: PendingDelivery): Promise<void> {
    const claimed = await this.store.claim(record.key, async () => {
      let current = await this.store.get(record.key) ?? record;
      if (!current.turn) return;
      const turn = current.turn;
      if (!current.l0) {
        try {
          await this.gateway.captureL0(turn);
          current = await this.store.mark(record.key, "l0") ?? current;
        } catch (error) {
          await this.log("warn", "L0 delivery remains pending", { sessionId: turn.sessionId, error: String(error) });
        }
      }
      if (!current.skill) {
        if (!this.config.skillEnabled) {
          await this.store.mark(record.key, "skill");
          return;
        }
        try {
          await this.gateway.captureSkill(turn);
          await this.store.mark(record.key, "skill");
        } catch (error) {
          await this.log("warn", "Skill delivery remains pending", { sessionId: turn.sessionId, error: String(error) });
        }
      }
    });
    if (!claimed && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.recover().catch((error) => this.log("warn", "Claimed delivery retry failed", { error: String(error) }));
      }, 1_000);
      this.retryTimer.unref();
    }
  }

  capture(sessionId: string, messages: OpenCodeMessage[]): Promise<void> {
    return this.enqueue(sessionId, async () => {
      const turns = completedTurns(sessionId, messages, this.config.maxMessageChars, this.config.maxSkillBytes);
      for (const turn of turns) {
        const record = await this.store.begin(turn, this.config.skillEnabled);
        if (!record.l0 || !record.skill) await this.deliver(record);
      }
    });
  }

  async recover(): Promise<void> {
    const pending = await this.store.pending();
    await Promise.all(pending.map((record) => this.enqueue(record.turn!.sessionId, () => this.deliver(record))));
  }
}
