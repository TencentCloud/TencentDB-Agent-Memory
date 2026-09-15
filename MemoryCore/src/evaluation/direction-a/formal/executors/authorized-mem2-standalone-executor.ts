import type { TaskAgentExecutionRequest, TaskAgentExecutionResult } from "../acquisition/contracts.js";
import type { NormalAgentExecutionRequest, TaskAgentExecutor } from "./task-agent-executor.js";
import type { OnlineMem2ActTask } from "../../online-like.js";
import { assertMem2PaidExecutionPermit, type Mem2PaidExecutionPermit } from "../acquisition/mem2-formal-stage-gate.js";
import {
  executeMem2StandaloneCall,
  Mem2TechnicalExecutionError,
  MEM2_V71_SYSTEM_PROMPT,
  proveMem2CallNotDispatched,
  recoverMem2StandaloneCall,
  type Mem2StandaloneProvider,
} from "./mem2-standalone-call.js";

export const AUTHORIZED_MEM2_STANDALONE_EXECUTOR_ID = "mem2-standalone-one-shot-deepseek-v4-pro-v7.1-formal-authorized-v1" as const;

export interface AuthorizedMem2StandaloneExecutorOptions {
  permit: Mem2PaidExecutionPermit;
  tasks: readonly OnlineMem2ActTask[];
  outputRoot: string;
  inputPricePerMillionCny: number;
  outputPricePerMillionCny: number;
  providerFactory: (attemptId: string) => Mem2StandaloneProvider;
}

export class AuthorizedMem2StandaloneExecutor implements TaskAgentExecutor {
  readonly executorKind = "PRODUCTION_AUTHORIZED" as const;
  readonly executorId = AUTHORIZED_MEM2_STANDALONE_EXECUTOR_ID;
  private readonly tasks = new Map<string, OnlineMem2ActTask>();

  constructor(private readonly options: AuthorizedMem2StandaloneExecutorOptions) {
    assertMem2PaidExecutionPermit(options.permit);
    if (!options.outputRoot || !(options.inputPricePerMillionCny > 0) || !(options.outputPricePerMillionCny > 0)) {
      throw new Error("AUTHORIZED_MEM2_EXECUTOR_OPTIONS_INVALID");
    }
    for (const task of options.tasks) {
      if (this.tasks.has(task.componentId)) throw new Error(`AUTHORIZED_MEM2_EXECUTOR_DUPLICATE_COMPONENT:${task.componentId}`);
      this.tasks.set(task.componentId, task);
    }
  }

  private task(componentId: string): OnlineMem2ActTask {
    const task = this.tasks.get(componentId);
    if (!task) throw new Error(`AUTHORIZED_MEM2_EXECUTOR_TASK_NOT_BOUND:${componentId}`);
    return task;
  }

  private executeBound(attemptId: string, componentId: string, arm: "NORMAL" | "FULL" | "REMOVE"): Promise<TaskAgentExecutionResult> {
    assertMem2PaidExecutionPermit(this.options.permit);
    return executeMem2StandaloneCall({
      attemptId,
      purpose: this.options.permit.purpose,
      task: this.task(componentId),
      arm,
      outputRoot: this.options.outputRoot,
      authorizationHash: this.options.permit.authorizationHash,
      requestHash: this.options.permit.requestHash,
      profileHash: this.options.permit.profileHash,
      protocolHash: this.options.permit.protocolHash,
      snapshotHash: this.options.permit.snapshotHash,
      systemPrompt: MEM2_V71_SYSTEM_PROMPT,
      inputPricePerMillionCny: this.options.inputPricePerMillionCny,
      outputPricePerMillionCny: this.options.outputPricePerMillionCny,
      provider: this.options.providerFactory(attemptId),
    });
  }

  async execute(request: TaskAgentExecutionRequest): Promise<TaskAgentExecutionResult> {
    if (request.normalUnit.causalGroupId !== request.armConfig.causalGroupId
      || request.normalUnit.statisticalClusterId !== request.armConfig.statisticalClusterId
      || request.armConfig.arm === undefined) throw new Error("AUTHORIZED_MEM2_EXECUTOR_REQUEST_BINDING_DRIFT");
    return this.executeBound(request.attemptId, request.normalUnit.causalGroupId, request.armConfig.arm);
  }

  executeNormal(request: NormalAgentExecutionRequest): Promise<TaskAgentExecutionResult> {
    return this.executeBound(request.attemptId, request.normalUnit.causalGroupId, "NORMAL");
  }

  async recover(request: TaskAgentExecutionRequest): Promise<TaskAgentExecutionResult | undefined> {
    const result = await recoverMem2StandaloneCall(this.options.outputRoot, request.attemptId,
      this.options.permit.authorizationHash, this.options.permit.requestHash);
    if (result?.technicalMetadata.observation === "TECHNICAL_INVALID") {
      throw new Mem2TechnicalExecutionError(request.attemptId, result.technicalMetadata);
    }
    return result;
  }

  async recoverNormal(request: NormalAgentExecutionRequest): Promise<TaskAgentExecutionResult | undefined> {
    const result = await recoverMem2StandaloneCall(this.options.outputRoot, request.attemptId,
      this.options.permit.authorizationHash, this.options.permit.requestHash);
    if (result?.technicalMetadata.observation === "TECHNICAL_INVALID") {
      throw new Mem2TechnicalExecutionError(request.attemptId, result.technicalMetadata);
    }
    return result;
  }

  proveNotDispatched(request: TaskAgentExecutionRequest): Promise<boolean> {
    return proveMem2CallNotDispatched(this.options.outputRoot, request.attemptId);
  }

  proveNormalNotDispatched(request: NormalAgentExecutionRequest): Promise<boolean> {
    return proveMem2CallNotDispatched(this.options.outputRoot, request.attemptId);
  }
}
