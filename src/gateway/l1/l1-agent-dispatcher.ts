import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  L1DispatchResult,
  L1ExtractionDispatcher,
} from "../../core/record/l1-agent-types.js";
import type { Logger } from "../../core/types.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import { StoreL1ConflictCandidates } from "../../repo/l1/l1-conflict-candidate-store.js";
import { RoleGate } from "../consolidation/role-gate.js";
import { acquireRoleExecutionLease } from "../../agents/role-execution-lease.js";
import type { RoleLegacyDefaults } from "../consolidation/role-contract-types.js";
import type { RoleLauncher } from "../consolidation/launchers/types.js";
import { executeL1RolePair } from "./l1-dispatch-pair.js";
import { resolveL1RolePair } from "./l1-role-resolution.js";
import { L1OperationTracker } from "./l1-operation-tracker.js";
import { recordL1DispatchFailure } from "./l1-dispatch-failure.js";

export interface L1AgentDispatcherOptions {
  dataDir: string;
  scratchRoot: string;
  roleDir: string;
  roleDefaults: RoleLegacyDefaults;
  launcherFor: (id: string) => RoleLauncher;
  logger: Logger;
  maxMemoriesPerSession: number;
  now?: () => number;
}

export class GatewayL1AgentDispatcher implements L1ExtractionDispatcher {
  private readonly gate = new RoleGate();
  private readonly now: () => number;
  private readonly operations = new L1OperationTracker();
  private vectorStore?: IMemoryStore;
  private embeddingService?: EmbeddingService;
  constructor(private readonly options: L1AgentDispatcherOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  configureRecallContext(input: {
    vectorStore?: IMemoryStore;
    embeddingService?: EmbeddingService;
  }): void {
    this.vectorStore = input.vectorStore;
    this.embeddingService = input.embeddingService;
  }

  resolveRoleContractHash(role: string): string {
    const pair = resolveL1RolePair({
      role,
      roleDir: this.options.roleDir,
      defaults: this.options.roleDefaults,
    });
    if (!pair.ok) throw new Error(pair.reason);
    return pair.extractor.contractHash;
  }

  async shutdown(): Promise<void> {
    await this.operations.stop();
  }

  trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    const tracked = this.operations.tryRun(operation);
    return tracked ?? Promise.reject(new Error("dispatcher is shutting down"));
  }

  dispatchExtraction(
    input: Parameters<L1ExtractionDispatcher["dispatchExtraction"]>[0],
  ): Promise<L1DispatchResult> {
    return this.operations.tryRun(() => this.executeExtraction(input)) ??
      Promise.resolve({ ok: false, kind: "busy", message: "dispatcher is shutting down" });
  }

  private async executeExtraction(
    input: Parameters<L1ExtractionDispatcher["dispatchExtraction"]>[0],
  ): Promise<L1DispatchResult> {
    const pair = resolveL1RolePair({
      role: input.role,
      roleDir: this.options.roleDir,
      defaults: this.options.roleDefaults,
    });
    if (!pair.ok)
      return { ok: false, kind: "role-disabled", message: pair.reason };
    const gateKey = input.role;
    const lease = acquireRoleExecutionLease({
      dataDir: this.options.dataDir,
      roleKey: gateKey,
      ttlMs: pair.extractor.policy.maxRunMs,
      gate: this.gate,
      logger: this.options.logger,
      nowMs: this.now(),
    });
    if (lease === null) {
      return { ok: false, kind: "busy", message: "assignment lock is held" };
    }
    const runId = randomUUID();
    const scratchDir = path.join(
      this.options.scratchRoot,
      "l1",
      input.workset.assignmentId,
      runId,
    );
    try {
      return await executeL1RolePair({
        ...this.options,
        now: this.now,
        input,
        extractor: pair.extractor,
        critic: pair.critic,
        lease,
        conflicts: new StoreL1ConflictCandidates(
          () => this.vectorStore,
          () => this.embeddingService,
          this.options.logger,
        ),
        runId,
        scratchDir,
        onHandleStarted: (attemptId, handle) =>
          this.operations.handleStarted(attemptId, handle),
        onHandleSettled: (attemptId) => this.operations.handleSettled(attemptId),
      });
    } catch (error) {
      return recordL1DispatchFailure({
        dataDir: this.options.dataDir,
        assignmentId: input.workset.assignmentId,
        runId,
        error,
        now: this.now,
      });
    } finally {
      lease.release();
    }
  }
}
