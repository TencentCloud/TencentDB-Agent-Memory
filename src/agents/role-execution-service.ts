import fs from "node:fs/promises";
import path from "node:path";
import {
  checkCapabilities,
  unusedBinding,
} from "../gateway/consolidation/launchers/capabilities.js";
import { isolationRefusal } from "../gateway/consolidation/launchers/isolation.js";
import type {
  LaunchInput,
  LaunchOutcome,
  RoleLauncher,
  RunningHandle,
} from "../gateway/consolidation/launchers/types.js";
import type { Logger } from "../core/types.js";
import { finishAttempt, recordAttempt } from "../gateway/control-plane/attempt-repo.js";
import type { ResolvedRoleContract } from "../gateway/consolidation/role-contract-types.js";

export interface RoleAttemptResult {
  outcome: LaunchOutcome;
  droppedBinding: string | null;
}

export type StdoutRoleResult =
  | { ok: true; attemptId: string; stdout: string }
  | { ok: false; attemptId: string; error: string };

/** Shared host-neutral gate used by consolidation and L1 role attempts. */
export async function launchRoleAttempt(input: {
  launcher: RoleLauncher;
  launch: LaunchInput;
  logger: Logger;
}): Promise<RoleAttemptResult> {
  const { launcher, launch, logger } = input;
  const droppedBinding = unusedBinding(
    launcher.id,
    launch.contract.binding.thinking,
    launcher.capabilities,
  );
  if (droppedBinding !== null) logger.warn?.(`[launcher] ${droppedBinding}`);

  const incompatible = checkCapabilities(
    launcher.id,
    launch.contract.requiresCapabilities ?? [],
    launcher.capabilities,
  );
  if (incompatible !== null)
    return { outcome: { ok: false, error: incompatible }, droppedBinding };
  const unconfinable = isolationRefusal(launch.contract);
  if (unconfinable !== null)
    return { outcome: { ok: false, error: unconfinable }, droppedBinding };

  try {
    return { outcome: await launcher.launch(launch), droppedBinding };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error?.(`[launcher] ${launcher.id} threw: ${message}`);
    return {
      outcome: {
        ok: false,
        error: { kind: "internal-launcher", message },
      },
      droppedBinding,
    };
  }
}

/** Shared durable Attempt lifecycle for stdout-based role protocols. */
export async function runStdoutRoleAttempt(input: {
  dataDir: string;
  runId: string;
  scratchDir: string;
  kind: "launch" | "critic";
  contract: ResolvedRoleContract;
  launcher: RoleLauncher;
  taskPrompt: string;
  logger: Logger;
  now: () => number;
  onHandleStarted?: (attemptId: string, handle: RunningHandle) => void;
  onHandleSettled?: (attemptId: string) => void;
}): Promise<StdoutRoleResult> {
  const nowIso = () => new Date(input.now()).toISOString();
  const attemptId = recordAttempt(
    input.dataDir,
    input.runId,
    input.kind,
    nowIso(),
  );
  await fs.mkdir(input.scratchDir, { recursive: true });
  const promptPath = path.join(
    input.scratchDir,
    `${input.kind}-${attemptId}-prompt.md`,
  );
  await fs.writeFile(promptPath, input.contract.prompt.text ?? "", "utf-8");
  const launched = await launchRoleAttempt({
    launcher: input.launcher,
    logger: input.logger,
    launch: {
      runId: input.runId,
      attemptId,
      cwd: input.scratchDir,
      promptPath,
      taskPrompt: input.taskPrompt,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      contract: input.contract,
    },
  });
  if (!launched.outcome.ok) {
    const error = `${launched.outcome.error.kind}: ${launched.outcome.error.message}`;
    finishAttempt(input.dataDir, attemptId, "failed", error, nowIso());
    return { ok: false, attemptId, error };
  }
  input.onHandleStarted?.(attemptId, launched.outcome.handle);
  const result = await launched.outcome.handle.completion.finally(() =>
    input.onHandleSettled?.(attemptId),
  );
  if (result.status !== "succeeded" || result.exitCode !== 0) {
    const error = result.error ?? `role ${result.status} (${result.exitCode})`;
    finishAttempt(input.dataDir, attemptId, result.status, error, nowIso());
    return { ok: false, attemptId, error };
  }
  finishAttempt(input.dataDir, attemptId, "succeeded", null, nowIso());
  return { ok: true, attemptId, stdout: result.stdout.trim() };
}
