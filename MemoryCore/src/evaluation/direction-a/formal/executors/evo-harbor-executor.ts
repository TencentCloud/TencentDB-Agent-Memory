import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { TaskAgentExecutionRequest, TaskAgentExecutionResult } from "../acquisition/contracts.js";
import type { AuthorizedExecutionPermit } from "../acquisition/execution-gate.js";
import { assertInitial6PaidExecutionWindow, INITIAL6_BUDGET_AUTHORITY } from "../config/initial6-budget-authority.js";
import { canonicalJson, hashCanonical, sha256 } from "../core/canonical.js";
import type { TechnicalInvalidReason } from "../core/contracts.js";
import type { CurrentFormalExecutionEventJournal } from "../prepilot/execution-state-attestation.js";
import { assertRealExecutionProfile, type RealExecutionProfile } from "../acquisition/execution-profile.js";
import { assertCurrentFormalInitial6Manifest, type CurrentFormalInitial6EvoPilotManifest, type Initial6PreparedGroupManifest } from "../pilot/initial6-manifest.js";
import type { TaskAgentExecutor } from "./task-agent-executor.js";
import { gradeEvoCaseSummary } from "../teacher/evo-case-summary.js";
import type { AuthorizedT1ExecutionPermit } from "../evo-t1/t1-execution-gate.js";
import { assertT1PreparedExecutionManifest, type T1ExactManifest, type T1PreparedExecutionManifest,
  type T1PreparedGroup } from "../evo-t1/t1-manifest.js";
import { assertT1PaidExecutionWindow, T1_PAID_WINDOW_AUTHORITY } from "../evo-t1/t1-paid-authority.js";
import { classifyPostVerifierCleanup, isCleanupOnlyException, isCompletedInterval, sanitizeHarborChildEnv } from "../evo-t1/t1-post-verifier-recovery.js";
import type { AuthorizedFreshExecutionPermit } from "../evo-fresh/fresh-execution-gate.js";
import { assertFreshPreparedExecutionManifest, type FreshExactManifest, type FreshPreparedExecutionManifest,
  type FreshPreparedGroup } from "../evo-fresh/fresh-manifest.js";
import { FRESH_PAID_AUTHORITY, assertFreshPaidAuthority } from "../evo-fresh/fresh-paid-authority.js";

export class LockedEvoHarborExecutor implements TaskAgentExecutor {
  readonly executorKind = "PRODUCTION_ADAPTER_LOCKED" as const;
  readonly executorId = "evo-harbor-terminus-2-deepseek-v4-pro-LOCKED";
  async execute(): Promise<never> { throw new Error("CORE_DECISION_REQUIRED:CDR-PAID-RUN: Harbor/Terminus-2 production executor requires an AuthorizedExecutionPermit"); }
}

export interface HarborProcessResult { exitCode: number; stdout: string; stderr: string }
export interface HarborProcessRunner {
  run(executable: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<HarborProcessResult>;
}

class DefaultHarborProcessRunner implements HarborProcessRunner {
  run(executable: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<HarborProcessResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) stdout = stdout.slice(-16 * 1024 * 1024); });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; if (stderr.length > 16 * 1024 * 1024) stderr = stderr.slice(-16 * 1024 * 1024); });
      child.once("error", reject);
      child.once("close", (exitCode) => resolvePromise({ exitCode: exitCode ?? -1, stdout, stderr }));
    });
  }
}

export class TechnicalExecutionError extends Error {
  constructor(readonly reason: TechnicalInvalidReason, message: string, readonly metadata: Record<string, unknown> = {}) {
    super(message); this.name = "TechnicalExecutionError";
  }
}

interface HarborAgentResult {
  n_input_tokens?: number;
  n_cache_tokens?: number;
  n_output_tokens?: number;
  metadata?: { n_episodes?: number; api_request_times_msec?: number[] };
}
interface HarborTrialResult {
  id?: string;
  task_name?: string;
  trial_name?: string;
  exception_info?: unknown;
  started_at?: string;
  finished_at?: string;
  verifier_result?: { rewards?: Record<string, number> };
  step_results?: Array<{ step_name?: string; agent_result?: HarborAgentResult; verifier_result?: { rewards?: Record<string, number> };
    exception_info?: unknown; agent_execution?: { started_at?: string; finished_at?: string }; verifier?: { started_at?: string; finished_at?: string } }>;
}

function costCny(inputTokens: number, cachedTokens: number, outputTokens: number,
  rates: { cacheHitInput: number; cacheMissInput: number; output: number }): number {
  return ((inputTokens - cachedTokens) * rates.cacheMissInput + cachedTokens * rates.cacheHitInput + outputTokens * rates.output) / 1_000_000;
}

function distribute(total: number, count: number, ordinal: number): number {
  const base = Math.floor(total / count); return base + (ordinal <= total % count ? 1 : 0);
}

export async function hashDirectoryTree(directory: string): Promise<string> {
  const paths: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path); else if (entry.isFile()) paths.push(path);
    }
  };
  await visit(directory); const hash = createHash("sha256");
  for (const path of paths) { hash.update(relative(directory, path).replaceAll("\\", "/")); hash.update("\0"); hash.update(await readFile(path)); hash.update("\0"); }
  return hash.digest("hex");
}

function classifyInfrastructureFailure(message: string): TechnicalInvalidReason {
  if (/rate.?limit|timeout|connection|network|provider|api.?error|http\s*5\d\d/i.test(message)) return "PROVIDER_NETWORK_INFRASTRUCTURE_FAILURE";
  if (/verifier.*(?:unavailable|exception|crash)|reward\.txt.*(?:missing|not found)/i.test(message)) return "VERIFIER_INFRASTRUCTURE_UNAVAILABLE";
  if (/restore|checksum|corrupt/i.test(message)) return "CORRUPTED_WORKSPACE_RESTORE";
  if (/schema|transport|parse.*response|adapter/i.test(message)) return "ADAPTER_SCHEMA_TRANSPORT_FAILURE";
  return "HARNESS_INFRASTRUCTURE_FAILURE";
}

function assertPermitBindings(permit: AuthorizedExecutionPermit, manifest: CurrentFormalInitial6EvoPilotManifest, profile: RealExecutionProfile): void {
  if (!permit.authorizationHash || permit.executionManifestHash !== manifest.contentHash || permit.profileHash !== profile.contentHash
    || permit.q6SealHash !== manifest.q6ExactSealHash || permit.q6CapacityReportHash !== manifest.q6CapacityReportHash
    || permit.q6HistoricalPreYAttestationHash !== manifest.q6HistoricalPreYAttestationHash
    || permit.executionStateAttestationHash !== manifest.executionStateAttestationHash
    || !permit.liveExecutionStateAttestationHash
    || permit.budgetAuthorityHash !== manifest.budgetAuthorityHash) throw new Error("AUTHORIZED_EXECUTOR_PERMIT_MANIFEST_BINDING_MISMATCH");
}

export interface EvoHarborExecutorOptions {
  permit?: AuthorizedExecutionPermit;
  manifest: CurrentFormalInitial6EvoPilotManifest;
  profile: RealExecutionProfile;
  repoRoot: string;
  harborExecutable: string;
  runtimeRoot: string;
  secrets?: Readonly<Record<string, string>>;
  executionJournal: CurrentFormalExecutionEventJournal;
  processRunner?: HarborProcessRunner;
  clock?: () => Date;
  recoveryOnly?: boolean;
}

type EvoHarborExecutionGroup = Omit<Initial6PreparedGroupManifest, "selectionRole" | "deepReference" | "validPairMaximum" | "validPairMinimum"> & {
  selectionRole: string; deepReference: boolean; validPairMaximum: number; validPairMinimum: number;
};

interface GenericEvoHarborExecutorOptions {
  manifest: { groups: EvoHarborExecutionGroup[] };
  profile: RealExecutionProfile;
  repoRoot: string;
  harborExecutable: string;
  runtimeRoot: string;
  secrets?: Readonly<Record<string, string>>;
  executionJournal: CurrentFormalExecutionEventJournal;
  processRunner?: HarborProcessRunner;
  clock?: () => Date;
  recoveryOnly?: boolean;
  policy: {
    executorId: string;
    jobPrefix: string;
    validate(): void;
    assertPaidWindow(now: Date): void;
    rates: { cacheHitInput: number; cacheMissInput: number; output: number };
  };
}

/** Generic Harbor mechanics. Authority/scope enter only through the injected, closed policy. */
class GenericEvoHarborExecutionCore implements TaskAgentExecutor {
  readonly executorKind = "PRODUCTION_AUTHORIZED" as const;
  readonly executorId: string;
  private readonly runner: HarborProcessRunner;
  private readonly clock: () => Date;

  constructor(private readonly options: GenericEvoHarborExecutorOptions) {
    options.policy.validate();
    assertRealExecutionProfile(options.profile);
    if (options.recoveryOnly && options.secrets && Object.keys(options.secrets).length) throw new Error("READ_ONLY_RECOVERY_MUST_NOT_RECEIVE_SECRETS");
    if (options.profile.environments.evo.horizon.kind !== "AGENT_TURNS"
      || options.profile.environments.evo.horizon.maxTurns !== 12
      || options.profile.environments.evo.maxOutputTokens !== 65536
      || options.profile.environments.evo.technicalRetryLimit !== 2
      || options.profile.environments.evo.scaffoldVersion !== "terminus-2@2.0.0") throw new Error("AUTHORIZED_EXECUTOR_FROZEN_PROFILE_MISMATCH");
    this.runner = options.processRunner ?? new DefaultHarborProcessRunner();
    this.clock = options.clock ?? (() => new Date());
    this.executorId = options.policy.executorId;
  }

  async execute(request: TaskAgentExecutionRequest): Promise<TaskAgentExecutionResult> {
    if (this.options.recoveryOnly) throw new Error("READ_ONLY_RECOVERY_FORBIDS_NEW_PAID_EXECUTION");
    const group = this.options.manifest.groups.find((row) => row.causalGroupId === request.armConfig.causalGroupId);
    if (!group) throw new Error(`PILOT_SELECTION_DIFFERS_FROM_FROZEN_MANIFEST:${request.armConfig.causalGroupId}`);
    if (request.normalUnit.taskId !== group.taskId || request.normalUnit.statisticalClusterId !== group.statisticalClusterId
      || request.normalUnit.frozenStateHash !== group.frozenPrefixHash || request.armConfig.frozenStateHash !== group.frozenPrefixHash
      || request.armConfig.targetSpecHash !== group.targetGroupHash) throw new Error("AUTHORIZED_EXECUTOR_FROZEN_ATTEMPT_BINDING_MISMATCH");
    const result = await this.executePreparedTask({ attemptId: request.attemptId, group, arm: request.armConfig.arm, pairIndex: request.armConfig.pairIndex });
    if (!result) throw new Error(`RESUME_PAID_ATTEMPT_STATE_AMBIGUOUS:${request.attemptId}:NO_DURABLE_RESULT`);
    return result;
  }

  async recover(request: TaskAgentExecutionRequest): Promise<TaskAgentExecutionResult | undefined> {
    const group = this.options.manifest.groups.find((row) => row.causalGroupId === request.armConfig.causalGroupId);
    if (!group) throw new Error(`PILOT_SELECTION_DIFFERS_FROM_FROZEN_MANIFEST:${request.armConfig.causalGroupId}`);
    return this.executePreparedTask({ attemptId: request.attemptId, group, arm: request.armConfig.arm, pairIndex: request.armConfig.pairIndex, recoveryOnly: true });
  }

  async proveNotDispatched(request: TaskAgentExecutionRequest): Promise<boolean> {
    const safeAttempt = request.attemptId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const jobRoot = resolve(this.options.runtimeRoot, "harbor-jobs", `${this.options.policy.jobPrefix}-${safeAttempt}`);
    try { await access(jobRoot); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const starts = (await this.options.executionJournal.read()).filter((row) => row.eventType === "PAID_TRIAL_STARTED" && row.attemptId === request.attemptId);
    return starts.length === 0;
  }

  async executeNormal(attemptId: string, group: EvoHarborExecutionGroup): Promise<TaskAgentExecutionResult> {
    if (this.options.recoveryOnly) throw new Error("READ_ONLY_RECOVERY_FORBIDS_NEW_PAID_EXECUTION");
    if (!this.options.manifest.groups.some((row) => row.causalGroupId === group.causalGroupId)) throw new Error(`PILOT_SELECTION_DIFFERS_FROM_FROZEN_MANIFEST:${group.causalGroupId}`);
    const result = await this.executePreparedTask({ attemptId, group, arm: "NORMAL" });
    if (!result) throw new Error(`RESUME_PAID_ATTEMPT_STATE_AMBIGUOUS:${attemptId}:NO_DURABLE_RESULT`);
    return result;
  }

  async recoverNormal(attemptId: string, group: EvoHarborExecutionGroup): Promise<TaskAgentExecutionResult | undefined> {
    if (!this.options.manifest.groups.some((row) => row.causalGroupId === group.causalGroupId)) throw new Error(`PILOT_SELECTION_DIFFERS_FROM_FROZEN_MANIFEST:${group.causalGroupId}`);
    return this.executePreparedTask({ attemptId, group, arm: "NORMAL", recoveryOnly: true });
  }

  async recoverPrepared(attemptId: string, group: EvoHarborExecutionGroup, arm: "NORMAL" | "FULL" | "REMOVE", pairIndex?: number): Promise<TaskAgentExecutionResult | undefined> {
    return this.executePreparedTask({ attemptId, group, arm, pairIndex, recoveryOnly: true });
  }

  private async executePreparedTask(input: { attemptId: string; group: EvoHarborExecutionGroup; arm: "NORMAL" | "FULL" | "REMOVE"; pairIndex?: number; recoveryOnly?: boolean }): Promise<TaskAgentExecutionResult | undefined> {
    const apiKey = this.options.secrets?.DIRECTION_A_API_KEY ?? this.options.secrets?.DEEPSEEK_API_KEY;
    const taskPath = input.arm === "NORMAL" ? input.group.normalTaskPath : input.arm === "FULL" ? input.group.fullTaskPath : input.group.removeTaskPath;
    const expectedTaskHash = input.arm === "NORMAL" ? input.group.normalTaskDirectoryHash
      : input.arm === "FULL" ? input.group.fullTaskDirectoryHash : input.group.removeTaskDirectoryHash;
    const absoluteTaskPath = resolve(this.options.repoRoot, taskPath);
    await access(absoluteTaskPath);
    if (await hashDirectoryTree(absoluteTaskPath) !== expectedTaskHash) throw new Error(`AUTHORIZED_EXECUTOR_TASK_DIRECTORY_HASH_MISMATCH:${input.group.causalGroupId}:${input.arm}`);
    const safeAttempt = input.attemptId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const jobName = `${this.options.policy.jobPrefix}-${safeAttempt}`;
    const jobsDir = resolve(this.options.runtimeRoot, "harbor-jobs");
    const jobRoot = join(jobsDir, jobName);
    let jobExists = true;
    try { await access(jobRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") jobExists = false; else throw error; }
    const config = {
      job_name: jobName, jobs_dir: jobsDir, n_concurrent_trials: 1, quiet: true,
      artifacts: [{ source: "/app", destination: "app-final" }],
      agents: [{ name: "terminus-2", model_name: "deepseek/deepseek-v4-pro", kwargs: {
        api_base: "https://api.deepseek.com", max_turns: 12, parser_name: "json", reasoning_effort: "high",
        interleaved_thinking: true, use_responses_api: true, enable_summarize: true, proactive_summarization_threshold: 8000,
        llm_kwargs: { timeout: 180 }, llm_call_kwargs: { max_output_tokens: 65536 },
      } }], tasks: [{ path: absoluteTaskPath }],
    };
    const configPath = resolve(this.options.runtimeRoot, "harbor-configs", `${safeAttempt}.json`);
    let configExists = true;
    try { await access(configPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") configExists = false; else throw error; }
    let processResult: HarborProcessResult = { exitCode: 0, stdout: "", stderr: "" };
    if (jobExists || input.recoveryOnly) {
      if (!jobExists) return undefined;
      let frozenConfig: unknown;
      try { frozenConfig = JSON.parse(await readFile(configPath, "utf8")); }
      catch { throw new Error(`RESUME_PAID_RESULT_INTEGRITY_UNPROVABLE:${input.attemptId}:CONFIG_MISSING_OR_INVALID`); }
      if (hashCanonical(frozenConfig) !== hashCanonical(config)) throw new Error(`RESUME_PAID_RESULT_INTEGRITY_UNPROVABLE:${input.attemptId}:CONFIG_DRIFT`);
      const starts = (await this.options.executionJournal.read()).filter((row) => row.eventType === "PAID_TRIAL_STARTED" && row.attemptId === input.attemptId);
      if (starts.length !== 1 || starts[0].jobName !== jobName || starts[0].arm !== input.arm) {
        throw new Error(`RESUME_PAID_RESULT_INTEGRITY_UNPROVABLE:${input.attemptId}:START_BINDING`);
      }
    } else {
      this.options.policy.assertPaidWindow(this.clock());
      if (!apiKey) throw new Error("AUTHORIZED_DIRECTION_A_API_KEY_MISSING");
      await mkdir(dirname(configPath), { recursive: true });
      if (configExists) {
        const frozenConfig = JSON.parse(await readFile(configPath, "utf8")) as unknown;
        if (hashCanonical(frozenConfig) !== hashCanonical(config)) throw new Error(`RESUME_PAID_RESULT_INTEGRITY_UNPROVABLE:${input.attemptId}:CONFIG_DRIFT`);
        const priorStarts = (await this.options.executionJournal.read()).filter((row) => row.eventType === "PAID_TRIAL_STARTED" && row.attemptId === input.attemptId);
        if (priorStarts.length) throw new Error(`RESUME_PAID_ATTEMPT_STATE_AMBIGUOUS:${input.attemptId}:START_WITHOUT_JOB`);
      } else await writeFile(configPath, `${canonicalJson(config)}\n`, { encoding: "utf8", flag: "wx" });
      await this.options.executionJournal.append({ eventType: "PAID_TRIAL_STARTED", occurredAt: this.clock().toISOString(),
        taskId: input.group.taskId, causalGroupId: input.group.causalGroupId, attemptId: input.attemptId,
        jobName, arm: input.arm, pairIndex: input.pairIndex });
      const dockerBin = "C:\\Program Files\\Docker\\Docker\\resources\\bin";
      processResult = await this.runner.run(this.options.harborExecutable, ["run", "-c", configPath, "--max-retries", "0", "--yes"], {
        cwd: this.options.repoRoot,
        env: sanitizeHarborChildEnv(process.env, { PATH: `${dockerBin};${process.env.PATH ?? ""}`, PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8", DEEPSEEK_API_KEY: apiKey }),
      });
    }
    let trialDirectories: string[] = [];
    try { trialDirectories = (await readdir(jobRoot, { withFileTypes: true })).filter((row) => row.isDirectory()).map((row) => join(jobRoot, row.name)); } catch { /* classified below */ }
    const trialRoot = trialDirectories.length === 1 ? trialDirectories[0] : undefined;
    let result: HarborTrialResult | undefined;
    const resultPath = trialRoot ? join(trialRoot, "result.json") : undefined;
    if (resultPath) try { result = JSON.parse(await readFile(resultPath, "utf8")) as HarborTrialResult; } catch { /* classified below */ }
    if (input.recoveryOnly && (!trialRoot || !result)) throw new Error(`RESUME_PAID_ATTEMPT_STATE_AMBIGUOUS:${input.attemptId}`);
    const step = result?.step_results?.[0]; const agent = step?.agent_result;
    const inputTokens = agent?.n_input_tokens ?? 0; const cachedTokens = agent?.n_cache_tokens ?? 0; const outputTokens = agent?.n_output_tokens ?? 0;
    const providerCalls = agent?.metadata?.n_episodes ?? agent?.metadata?.api_request_times_msec?.length ?? 0;
    const usageValid = [inputTokens, cachedTokens, outputTokens, providerCalls].every((value) => Number.isInteger(value) && value >= 0)
      && cachedTokens <= inputTokens;
    if (!usageValid) throw new TechnicalExecutionError("ADAPTER_SCHEMA_TRANSPORT_FAILURE", `Harbor usage metadata invalid for ${input.attemptId}`);
    const actualCostCny = costCny(inputTokens, cachedTokens, outputTokens, this.options.policy.rates);
    const priorEvents = await this.options.executionJournal.read();
    for (let ordinal = 1; ordinal <= providerCalls; ordinal += 1) {
      const expected = { inputTokens: distribute(inputTokens, providerCalls, ordinal), cachedInputTokens: distribute(cachedTokens, providerCalls, ordinal),
        outputTokens: distribute(outputTokens, providerCalls, ordinal), amountCny: actualCostCny / providerCalls };
      const prior = priorEvents.find((row) => row.eventType === "PROVIDER_CALL_COMPLETED" && row.attemptId === input.attemptId && row.providerCallOrdinal === ordinal);
      if (prior) {
        if (prior.inputTokens !== expected.inputTokens || prior.cachedInputTokens !== expected.cachedInputTokens
          || prior.outputTokens !== expected.outputTokens || Math.abs((prior.amountCny ?? -1) - expected.amountCny) > 1e-12) {
          throw new Error(`CURRENT_FORMAL_EXECUTION_STATE_AMBIGUOUS:${input.attemptId}:USAGE_LEDGER_DRIFT`);
        }
      } else await this.options.executionJournal.append({ eventType: "PROVIDER_CALL_COMPLETED",
        occurredAt: this.clock().toISOString(), taskId: input.group.taskId, causalGroupId: input.group.causalGroupId,
        attemptId: input.attemptId, providerCallOrdinal: ordinal, ...expected });
    }
    const nativeAgentExecutionStarted = Boolean(agent) && providerCalls > 0;
    if (nativeAgentExecutionStarted
      && !priorEvents.some((row) => row.eventType === "REAL_AGENT_TRIAL_COMPLETED" && row.attemptId === input.attemptId)) {
      await this.options.executionJournal.append({ eventType: "REAL_AGENT_TRIAL_COMPLETED", occurredAt: this.clock().toISOString(),
        taskId: input.group.taskId, causalGroupId: input.group.causalGroupId, attemptId: input.attemptId, amountCny: actualCostCny });
    }
    if (providerCalls > this.options.profile.environments.evo.horizon.maxTurns) throw new Error(`EXECUTION_PROFILE_HORIZON_VIOLATION:${providerCalls}`);
    if (!trialRoot || !result || step?.exception_info || !agent || providerCalls < 1) {
      const message = [processResult.stderr, processResult.stdout, JSON.stringify(result?.exception_info ?? step?.exception_info ?? {})].join("\n");
      if (resultPath) await this.appendTerminalExactlyOnce(input, "TECHNICAL_INVALID", sha256(await readFile(resultPath)));
      throw new TechnicalExecutionError(classifyInfrastructureFailure(message), `Harbor trial failed for ${input.attemptId}`, {
        exitCode: processResult.exitCode, providerCalls, actualCostCny, configHash: hashCanonical(config), resultPresent: Boolean(result) });
    }
    const trajectoryPath = join(trialRoot, "steps", "target-round", "agent", "trajectory.json");
    const verifierPath = join(trialRoot, "steps", "target-round", "verifier", "test-stdout.txt");
    const exceptionPath = join(trialRoot, "exception.txt");
    let rawTrajectory: string; let verifierOutput: string;
    try { [rawTrajectory, verifierOutput] = await Promise.all([readFile(trajectoryPath, "utf8"), readFile(verifierPath, "utf8")]); }
    catch (error) {
      await this.appendTerminalExactlyOnce(input, "TECHNICAL_INVALID", sha256(await readFile(resultPath!)));
      throw new TechnicalExecutionError("VERIFIER_INFRASTRUCTURE_UNAVAILABLE", `Harbor output artifact missing for ${input.attemptId}`, { providerCalls, actualCostCny, cause: (error as Error).message });
    }
    let trajectory: { steps?: Array<{ source?: string; message?: string }> };
    try { trajectory = JSON.parse(rawTrajectory) as { steps?: Array<{ source?: string; message?: string }> }; }
    catch (error) {
      await this.appendTerminalExactlyOnce(input, "TECHNICAL_INVALID", sha256(await readFile(resultPath!)));
      throw new TechnicalExecutionError("ADAPTER_SCHEMA_TRANSPORT_FAILURE", `Harbor trajectory invalid for ${input.attemptId}`,
        { providerCalls, actualCostCny, cause: (error as Error).message });
    }
    const rawCompletion = [...(trajectory.steps ?? [])].reverse().find((row) => row.source === "agent")?.message ?? "";
    const reward = step.verifier_result?.rewards?.reward ?? result.verifier_result?.rewards?.reward;
    const resultHash = sha256(await readFile(resultPath!));
    let verifierSource: string | undefined;
    try { verifierSource = await readFile(join(absoluteTaskPath, "steps", "target-round", "tests", "test.sh"), "utf8"); } catch { /* normal CASE_SUMMARY path does not require source bytes */ }
    let graded: ReturnType<typeof gradeEvoCaseSummary>;
    try { graded = gradeEvoCaseSummary({ verifierId: this.options.profile.environments.evo.verifierId,
      verifierVersion: this.options.profile.environments.evo.verifierVersion, rawVerifierOutput: verifierOutput,
      frozenTotalCases: input.group.frozenTotalCases, numericReward: reward,
      compileFailureEvidence: verifierSource && input.pairIndex && input.arm !== "NORMAL" ? {
        attemptId: input.attemptId, taskId: input.group.taskId, causalGroupId: input.group.causalGroupId,
        pairIndex: input.pairIndex, arm: input.arm, verifierSource, verifierSourceSha256: sha256(verifierSource),
        rawVerifierOutputSha256: sha256(verifierOutput), resultSha256: resultHash,
        infrastructureExceptionPresent: Boolean(result.exception_info || step.exception_info),
      } : undefined }); }
    catch (error) {
      await this.appendTerminalExactlyOnce(input, "TECHNICAL_INVALID", sha256(await readFile(resultPath!)));
      throw new TechnicalExecutionError("VERIFIER_INFRASTRUCTURE_UNAVAILABLE", `Native CASE_SUMMARY invalid for ${input.attemptId}`,
        { providerCalls, actualCostCny, cause: (error as Error).message });
    }
    if (result.exception_info) {
      let exceptionText = JSON.stringify(result.exception_info);
      try { exceptionText += `\n${await readFile(exceptionPath, "utf8")}`; } catch { /* absence fails the strict proof */ }
      const currentEvents = await this.options.executionJournal.read();
      const starts = currentEvents.filter((row) => row.eventType === "PAID_TRIAL_STARTED" && row.attemptId === input.attemptId);
      const finishes = currentEvents.filter((row) => row.eventType === "PAID_TRIAL_FINISHED" && row.attemptId === input.attemptId);
      const usageRows = currentEvents.filter((row) => row.eventType === "PROVIDER_CALL_COMPLETED" && row.attemptId === input.attemptId);
      const trialFinishedAt = Date.parse(result.finished_at ?? ""); const verifierFinishedAt = Date.parse(step.verifier?.finished_at ?? "");
      const cleanup = classifyPostVerifierCleanup({
        agentExecutionCompleted: isCompletedInterval(step.agent_execution),
        agentResultDurableAndParseable: Boolean(agent) && usageValid,
        verifierExecutionCompleted: isCompletedInterval(step.verifier),
        verifierResultDurableAndParseable: Boolean(step.verifier_result ?? result.verifier_result) && Number.isFinite(reward),
        caseSummaryComplete: graded.summary.totalCases === input.group.frozenTotalCases,
        denominatorAccountingValid: graded.outcome.denominator === input.group.frozenTotalCases,
        trajectoryProvenanceDurableAndParseable: Array.isArray(trajectory.steps) && trajectory.steps.length > 0 && rawCompletion.length > 0,
        providerUsageAndCostReconciled: usageRows.length === providerCalls
          && new Set(usageRows.map((row) => row.providerCallOrdinal)).size === providerCalls
          && usageRows.every((row) => Number.isFinite(row.amountCny)),
        exceptionOccurredAfterMeasurement: Number.isFinite(trialFinishedAt) && Number.isFinite(verifierFinishedAt)
          && trialFinishedAt >= verifierFinishedAt && !step.exception_info,
        cleanupTeardownOnly: isCleanupOnlyException(exceptionText),
        taskGroupAttemptIdentityUnambiguous: result.task_name === basename(absoluteTaskPath)
          && typeof result.id === "string" && result.id.length > 0 && typeof result.trial_name === "string" && result.trial_name.length > 0,
        dispatchUniqueAndReconciled: starts.length === 1 && finishes.length <= 1
          && starts[0].jobName === jobName && starts[0].arm === input.arm
          && finishes.every((row) => row.resultHash === resultHash),
      });
      if (!cleanup.salvageQualified) {
        await this.appendTerminalExactlyOnce(input, "TECHNICAL_INVALID", resultHash);
        const reason = classifyInfrastructureFailure([processResult.stderr, processResult.stdout, exceptionText].join("\n"));
        throw new TechnicalExecutionError(reason, `Harbor trial failed strict post-verifier cleanup proof for ${input.attemptId}`,
          { exitCode: processResult.exitCode, providerCalls, actualCostCny, classification: cleanup.classification, failedCriteria: cleanup.failedCriteria });
      }
    }
    await this.appendTerminalExactlyOnce(input, "VALID_RESULT", resultHash);
    return { rawTrajectory, rawCompletion, verifierOutput, technicalMetadata: { jobName, trialName: result.trial_name,
      taskName: result.task_name, arm: input.arm, providerCalls, inputTokens, cachedTokens, outputTokens, actualCostCny,
      reward, gradedOutcome: graded.outcome, caseSummary: graded.summary, gradingClassification: graded.classification,
      scientificFailureReason: graded.scientificFailureReason, verifierProvenanceHash: graded.provenanceHash,
      configHash: hashCanonical(config), resultHash } };
  }

  private async appendTerminalExactlyOnce(input: { attemptId: string; group: EvoHarborExecutionGroup; arm: "NORMAL" | "FULL" | "REMOVE"; pairIndex?: number },
    terminalStatus: "VALID_RESULT" | "TECHNICAL_INVALID", resultHash: string): Promise<void> {
    const prior = (await this.options.executionJournal.read()).filter((row) => row.eventType === "PAID_TRIAL_FINISHED" && row.attemptId === input.attemptId);
    if (prior.length > 1 || (prior.length === 1 && (prior[0].terminalStatus !== terminalStatus || prior[0].resultHash !== resultHash))) {
      throw new Error(`CURRENT_FORMAL_EXECUTION_STATE_AMBIGUOUS:${input.attemptId}:TERMINAL_LEDGER_DRIFT`);
    }
    if (!prior.length) await this.options.executionJournal.append({ eventType: "PAID_TRIAL_FINISHED", occurredAt: this.clock().toISOString(),
      taskId: input.group.taskId, causalGroupId: input.group.causalGroupId, attemptId: input.attemptId,
      jobName: `${this.options.policy.jobPrefix}-${input.attemptId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, arm: input.arm, resultHash, terminalStatus });
  }
}

export class AuthorizedEvoHarborExecutor extends GenericEvoHarborExecutionCore {
  constructor(options: EvoHarborExecutorOptions) {
    if (options.recoveryOnly) {
      if (options.permit || (options.secrets && Object.keys(options.secrets).length)) throw new Error("READ_ONLY_RECOVERY_MUST_NOT_RECEIVE_PERMIT_OR_SECRETS");
    } else {
      if (!options.permit) throw new Error("PAID_EXECUTION_LOCKED: authorized permit absent");
      assertPermitBindings(options.permit, options.manifest, options.profile);
    }
    super({ ...options, policy: {
      executorId: "evo-harbor-terminus-2-deepseek-v4-pro-authorized-v1", jobPrefix: "initial6",
      validate: () => assertCurrentFormalInitial6Manifest(options.manifest),
      assertPaidWindow: assertInitial6PaidExecutionWindow, rates: INITIAL6_BUDGET_AUTHORITY.ratesCnyPerMillionTokens,
    } });
  }
}

export interface T1EvoHarborExecutorOptions extends Omit<EvoHarborExecutorOptions, "permit" | "manifest"> {
  permit?: AuthorizedT1ExecutionPermit;
  manifest: T1PreparedExecutionManifest;
  scopeManifest: T1ExactManifest;
}

export class AuthorizedT1EvoHarborExecutor extends GenericEvoHarborExecutionCore {
  constructor(options: T1EvoHarborExecutorOptions) {
    if (options.recoveryOnly) {
      if (options.permit || (options.secrets && Object.keys(options.secrets).length)) throw new Error("READ_ONLY_RECOVERY_MUST_NOT_RECEIVE_PERMIT_OR_SECRETS");
    } else {
      if (!options.permit || options.permit.kind !== "EVO_ENGINEERING_FIRST_T1") throw new Error("T1_PAID_EXECUTION_LOCKED: authorized T1 permit absent");
      if (options.permit.manifestHash !== options.scopeManifest.contentHash || options.permit.profileHash !== options.profile.contentHash
        || options.permit.paidWindowAuthorityHash !== T1_PAID_WINDOW_AUTHORITY.contentHash) throw new Error("T1_AUTHORIZED_EXECUTOR_PERMIT_BINDING_MISMATCH");
    }
    const manifest = options.manifest as T1PreparedExecutionManifest & { groups: T1PreparedGroup[] };
    super({ ...options, manifest, policy: {
      executorId: "evo-harbor-terminus-2-deepseek-v4-pro-t1-authorized-v2", jobPrefix: "evo-t1",
      validate: () => assertT1PreparedExecutionManifest(manifest, options.scopeManifest),
      assertPaidWindow: assertT1PaidExecutionWindow, rates: T1_PAID_WINDOW_AUTHORITY.ratesCnyPerMillionTokens,
    } });
  }
}

export interface FreshEvoHarborExecutorOptions extends Omit<EvoHarborExecutorOptions, "permit" | "manifest"> {
  permit?: AuthorizedFreshExecutionPermit;
  manifest: FreshPreparedExecutionManifest;
  exactManifest: FreshExactManifest;
}

/** Fresh-specific authority wrapper; all Harbor mechanics remain in the shared core. */
export class AuthorizedFreshEvoHarborExecutor extends GenericEvoHarborExecutionCore {
  constructor(options: FreshEvoHarborExecutorOptions) {
    if (options.recoveryOnly) {
      if (options.permit || (options.secrets && Object.keys(options.secrets).length)) {
        throw new Error("READ_ONLY_RECOVERY_MUST_NOT_RECEIVE_PERMIT_OR_SECRETS");
      }
    } else {
      if (!options.permit || options.permit.kind !== "EVO_FRESH_ENGINEERING_HOLDOUT") {
        throw new Error("FRESH_PAID_EXECUTION_LOCKED: authorized fresh permit absent");
      }
      if (options.permit.exactManifestHash !== options.exactManifest.contentHash
        || options.permit.preparedManifestHash !== options.manifest.contentHash
        || options.permit.runtimeRoot !== options.manifest.runtimeRoot
        || options.permit.profileHash !== options.profile.contentHash
        || options.permit.paidAuthorityHash !== FRESH_PAID_AUTHORITY.contentHash) {
        throw new Error("FRESH_AUTHORIZED_EXECUTOR_PERMIT_BINDING_MISMATCH");
      }
    }
    const manifest = options.manifest as FreshPreparedExecutionManifest & { groups: FreshPreparedGroup[] };
    super({ ...options, manifest, policy: {
      executorId: "evo-harbor-terminus-2-deepseek-v4-pro-fresh-n9-authorized-v1",
      jobPrefix: "evo-fresh-n9",
      validate: () => assertFreshPreparedExecutionManifest(manifest, options.exactManifest),
      assertPaidWindow: assertFreshPaidAuthority,
      rates: FRESH_PAID_AUTHORITY.ratesCnyPerMillionTokens,
    } });
  }
}
