import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashCanonical, sha256 } from "../core/canonical.js";
import type { TaskAgentExecutionResult } from "../acquisition/contracts.js";
import { gradeMem2ToolCall } from "../teacher/mem2-argument-f1.js";
import { isMem2ToolActionEnvelope, parseMem2ActionSameRaw, scientificActionFailure } from "../teacher/mem2-continuous-reference.js";
import { renderOnlineMem2ActPrompt, type OnlineMem2ActTask } from "../../online-like.js";
import { withEvaluationContext } from "../../context.js";

export const MEM2_V71_SYSTEM_PROMPT = "You are a memory-grounded tool-routing agent. Use only the frozen memory context and target tool schema. Return one tool call as JSON. Never use external tools." as const;
export const MEM2_V71_PROVIDER_PROFILE = Object.freeze({
  provider: "deepseek" as const,
  baseUrlOrigin: "https://api.deepseek.com" as const,
  model: "deepseek-v4-pro" as const,
  reasoningEffort: "low" as const,
  maxOutputTokens: 8192 as const,
  timeoutMs: 300000 as const,
  sdkRetry: 0 as const,
  technicalRetry: 0 as const,
  toolsEnabled: false as const,
});

export type Mem2StandaloneCallArm = "NORMAL" | "FULL" | "REMOVE";

export interface Mem2StandaloneProvider {
  lastUsage?: { promptTokens: number; completionTokens: number };
  lastFinishReason?: string;
  run(input: { taskId: string; systemPrompt: string; prompt: string; workspaceDir: string;
    enableTools: false; maxTokens: 8192; timeoutMs: 300000 }): Promise<string>;
}

export interface Mem2StandaloneCallInput {
  attemptId: string;
  purpose: "POST_ADAPTER_MINIMUM_SMOKE" | "MEM2_FORMAL_TRAIN_DEV" | "MEM2_CAL_CHEAP_X_AND_POLICY_FREEZE_ONLY"
    | "MEM2_DEV_SUPPORT_AUGMENTATION_V1" | "MEM2_CAL_A1_CAUSAL_AUDIT";
  task: OnlineMem2ActTask;
  arm: Mem2StandaloneCallArm;
  outputRoot: string;
  authorizationHash: string;
  requestHash: string;
  profileHash: string;
  protocolHash: string;
  snapshotHash: string;
  systemPrompt: typeof MEM2_V71_SYSTEM_PROMPT;
  inputPricePerMillionCny: number;
  outputPricePerMillionCny: number;
  provider: Mem2StandaloneProvider;
}

interface DurableResultEnvelope {
  schemaVersion: "direction-a.mem2-v7.1.standalone-call-result.v1";
  attemptId: string;
  authorizationHash: string;
  requestHash: string;
  arm: Mem2StandaloneCallArm;
  result: TaskAgentExecutionResult;
  contentHash: string;
}

const callBase = (root: string, attemptId: string): string => path.join(root, "calls", sha256(attemptId));

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function immutableWrite(file: string, bytes: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(file, "utf8") !== bytes) throw error;
  }
}

export class Mem2TechnicalExecutionError extends Error {
  readonly reason = "PROVIDER_NETWORK_INFRASTRUCTURE_FAILURE" as const;
  constructor(readonly attemptId: string, readonly metadata: Record<string, unknown>) {
    super(`MEM2_TECHNICAL_INVALID:${attemptId}:PROVIDER_NETWORK_INFRASTRUCTURE_FAILURE`);
    this.name = "Mem2TechnicalExecutionError";
  }
}

export async function executeMem2StandaloneCall(input: Mem2StandaloneCallInput): Promise<TaskAgentExecutionResult> {
  if (!input.attemptId || !input.authorizationHash || !input.requestHash || !input.profileHash || !input.protocolHash
    || !input.snapshotHash || input.systemPrompt !== MEM2_V71_SYSTEM_PROMPT
    || !(input.inputPricePerMillionCny > 0) || !(input.outputPricePerMillionCny > 0)) throw new Error("MEM2_STANDALONE_CALL_BINDING_INVALID");
  const base = callBase(input.outputRoot, input.attemptId);
  const intentPath = `${base}.intent.json`;
  const rawPath = `${base}.raw.txt`;
  const resultPath = `${base}.result.json`;
  if (await exists(intentPath)) throw new Error(`FORMAL_EXECUTION_HOLD_UNCERTAIN_CALL:${input.attemptId}`);
  const includedSourceIds = input.arm === "REMOVE"
    ? input.task.sourceConversationIds.filter((id) => id !== input.task.targetSourceId)
    : input.task.sourceConversationIds;
  const prompt = renderOnlineMem2ActPrompt(input.task, includedSourceIds);
  const intentBody = {
    schemaVersion: "direction-a.mem2-v7.1.standalone-call-intent.v1",
    attemptId: input.attemptId,
    purpose: input.purpose,
    componentId: input.task.componentId,
    qaId: input.task.qaId,
    taskInputHash: input.task.taskInputHash,
    arm: input.arm,
    promptHash: sha256(prompt),
    authorizationHash: input.authorizationHash,
    requestHash: input.requestHash,
    profileHash: input.profileHash,
    protocolHash: input.protocolHash,
    snapshotHash: input.snapshotHash,
    providerProfile: MEM2_V71_PROVIDER_PROFILE,
    countsAsFullReplicate: input.arm === "FULL",
    countsAsCausalPairArm: input.arm !== "NORMAL",
    containsCausalY: input.arm !== "NORMAL",
  };
  await immutableWrite(intentPath, `${JSON.stringify({ ...intentBody, contentHash: hashCanonical(intentBody) }, null, 2)}\n`);
  let raw: string;
  try {
    raw = await withEvaluationContext({
      runId: `${input.purpose}:${input.requestHash}`,
      episodeId: input.attemptId,
      taskId: input.task.qaId,
    }, () => input.provider.run({ taskId: input.attemptId, systemPrompt: input.systemPrompt, prompt,
      workspaceDir: input.outputRoot, enableTools: false, maxTokens: 8192, timeoutMs: 300000 }));
  } catch (error) {
    const result: TaskAgentExecutionResult = {
      rawTrajectory: "",
      rawCompletion: "",
      verifierOutput: JSON.stringify({ observation: "TECHNICAL_INVALID", utility: null }),
      technicalMetadata: { observation: "TECHNICAL_INVALID", technicalReason: "PROVIDER_NETWORK_INFRASTRUCTURE_FAILURE",
        providerErrorHash: hashCanonical(String(error)), usage: null, observedUsageCostCny: null,
        arm: input.arm, containsCausalY: false },
    };
    const body = { schemaVersion: "direction-a.mem2-v7.1.standalone-call-result.v1" as const,
      attemptId: input.attemptId, authorizationHash: input.authorizationHash, requestHash: input.requestHash, arm: input.arm, result };
    await immutableWrite(resultPath, `${JSON.stringify({ ...body, contentHash: hashCanonical(body) }, null, 2)}\n`);
    throw new Mem2TechnicalExecutionError(input.attemptId, result.technicalMetadata);
  }
  await immutableWrite(rawPath, raw);
  const parsed = parseMem2ActionSameRaw(raw, isMem2ToolActionEnvelope);
  const outcome = parsed.valid ? gradeMem2ToolCall({ verifierId: "mem2", verifierVersion: "1A.v1",
    gold: { tool: input.task.goldToolCall.name, arguments: input.task.goldToolCall.arguments as never },
    predicted: { tool: parsed.value!.name, arguments: parsed.value!.arguments as never } }).outcome : undefined;
  const failure = outcome ? undefined : scientificActionFailure("MALFORMED_OR_SCHEMA_INVALID_ACTION");
  const usage = input.provider.lastUsage;
  const observedUsageCostCny = usage
    ? usage.promptTokens * input.inputPricePerMillionCny / 1e6 + usage.completionTokens * input.outputPricePerMillionCny / 1e6
    : null;
  const result: TaskAgentExecutionResult = {
    rawTrajectory: raw,
    rawCompletion: raw,
    verifierOutput: JSON.stringify(outcome ?? { ...failure, utility: 0 }),
    technicalMetadata: {
      observation: "SCIENTIFICALLY_OBSERVED",
      utility: outcome?.utility ?? 0,
      strictPass: outcome?.strictPass ?? false,
      outcomeHash: hashCanonical(outcome ?? { ...failure, utility: 0 }),
      rawCompletionHash: sha256(raw),
      scientificActionFailure: failure,
      usage: usage ?? null,
      observedUsageCostCny,
      finishReason: input.provider.lastFinishReason ?? null,
      arm: input.arm,
      independentNormal: input.arm === "NORMAL",
      countsAsFullReplicate: input.arm === "FULL",
      countsAsCausalPairArm: input.arm !== "NORMAL",
      containsCausalY: input.arm !== "NORMAL",
    },
  };
  const body = { schemaVersion: "direction-a.mem2-v7.1.standalone-call-result.v1" as const,
    attemptId: input.attemptId, authorizationHash: input.authorizationHash, requestHash: input.requestHash, arm: input.arm, result };
  await immutableWrite(resultPath, `${JSON.stringify({ ...body, contentHash: hashCanonical(body) }, null, 2)}\n`);
  return result;
}

export async function recoverMem2StandaloneCall(outputRoot: string, attemptId: string,
  authorizationHash: string, requestHash: string): Promise<TaskAgentExecutionResult | undefined> {
  const file = `${callBase(outputRoot, attemptId)}.result.json`;
  if (!await exists(file)) return undefined;
  const envelope = JSON.parse(await readFile(file, "utf8")) as DurableResultEnvelope;
  const { contentHash, ...body } = envelope;
  if (hashCanonical(body) !== contentHash || envelope.attemptId !== attemptId
    || envelope.authorizationHash !== authorizationHash || envelope.requestHash !== requestHash) {
    throw new Error(`FORMAL_EXECUTION_HOLD_UNCERTAIN_CALL:${attemptId}:DURABLE_RESULT_BINDING_DRIFT`);
  }
  return envelope.result;
}

export async function proveMem2CallNotDispatched(outputRoot: string, attemptId: string): Promise<boolean> {
  return !await exists(`${callBase(outputRoot, attemptId)}.intent.json`);
}
