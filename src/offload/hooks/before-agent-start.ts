/**
 * before_agent_start hook handler.
 * Implements L1.5: Task completion judgment and active MMD management.
 *
 * Backend-only mode: local LLM judge has been removed.
 * Only normalizeJudgment and handleTaskTransition are exported for use by index.ts.
 */
import { readMmd, writeMmd, deleteMmd, type StorageContext } from "../storage.js";
import type { OffloadStateManager } from "../state-manager.js";
import type { PluginLogger, TaskJudgment } from "../types.js";
import { sanitizeMmdFilename, sanitizeMmdLabel } from "../mmd-path.js";

/**
 * Normalize a raw L1.5 judgment response (from backend)
 * into a safe TaskJudgment with guaranteed boolean fields.
 * Handles null/undefined values from backend fallback responses.
 */
export function normalizeJudgment(raw: Record<string, unknown>): TaskJudgment | null {
  // All-null response from backend means "LLM unavailable" — treat as no judgment
  if (raw.taskCompleted == null && raw.isContinuation == null && raw.isLongTask == null) {
    return null;
  }
  return {
    taskCompleted: Boolean(raw.taskCompleted),
    isContinuation: Boolean(raw.isContinuation),
    continuationMmdFile:
      typeof raw.continuationMmdFile === "string" ? raw.continuationMmdFile : undefined,
    newTaskLabel:
      typeof raw.newTaskLabel === "string" ? raw.newTaskLabel : undefined,
    isLongTask: Boolean(raw.isLongTask),
  };
}

export async function handleTaskTransition(
  stateManager: OffloadStateManager,
  judgment: TaskJudgment,
  logger: PluginLogger,
): Promise<void> {
  const rawCurrentMmd = stateManager.getActiveMmdFile();
  const currentMmd = rawCurrentMmd ? sanitizeMmdFilename(rawCurrentMmd) : null;

  const ctx = stateManager.ctx;

  const isEmptyShellMmd = async (filename: string | null): Promise<boolean> => {
    if (!filename) return false;
    try {
      const content = await readMmd(ctx, filename);
      if (!content) return false;
      const trimmed = content.trim();
      if (trimmed.includes("%%{")) return false;
      const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
      return lines.length <= 3;
    } catch {
      return false;
    }
  };

  const cleanupIfEmptyShell = async (oldFilename: string | null) => {
    if (!oldFilename) return;
    const isShell = await isEmptyShellMmd(oldFilename);
    if (isShell) {
      try {
        await deleteMmd(ctx, oldFilename);
      } catch {
        /* ignore */
      }
    }
  };

  const createNewMmd = async (label: string) => {
    const num = await stateManager.nextMmdNumber();
    const paddedNum = String(num).padStart(3, "0");
    const safeLabel = sanitizeMmdLabel(label);
    const filename = `${paddedNum}-${safeLabel}.mmd`;
    logger.debug?.(`[context-offload] L1.5: Creating new MMD: ${filename} (replacing ${currentMmd ?? "(none)"})`);
    await cleanupIfEmptyShell(currentMmd);
    stateManager.setActiveMmd(filename, safeLabel);
    const initialMmd = `flowchart TD\n    ${paddedNum}-N1["${safeLabel}"]\n`;
    await writeMmd(ctx, filename, initialMmd);
    logger.debug?.(`[context-offload] L1.5: New MMD created and activated: ${filename}`);
  };

  const reactivateMmd = async (contFile: string) => {
    const safeContFile = sanitizeMmdFilename(contFile);
    logger.debug?.(`[context-offload] L1.5: Reactivating MMD: ${safeContFile} (current=${currentMmd ?? "(none)"})`);
    if (currentMmd && currentMmd !== safeContFile) {
      await cleanupIfEmptyShell(currentMmd);
    }
    const mmdId = sanitizeMmdLabel(safeContFile.replace(/^\d+-/, "").replace(/\.mmd$/, ""));
    stateManager.setActiveMmd(safeContFile, mmdId);
    const existing = await readMmd(ctx, safeContFile);
    if (existing === null) {
      const prefixMatch = safeContFile.match(/^(\d+)-/);
      const prefix = prefixMatch ? prefixMatch[1] : "000";
      const initialMmd = `flowchart TD\n    ${prefix}-N1["${mmdId}"]\n`;
      await writeMmd(ctx, safeContFile, initialMmd);
      logger.warn(`[context-offload] L1.5: Reactivated MMD file was missing, wrote initial template: ${safeContFile}`);
    }
  };

  if (judgment.taskCompleted) {
    logger.debug?.(`[context-offload] L1.5: Task COMPLETED — continuation=${judgment.isContinuation}, longTask=${judgment.isLongTask}, contFile=${judgment.continuationMmdFile ?? "N/A"}, newLabel=${judgment.newTaskLabel ?? "N/A"}`);
    if (judgment.isContinuation && judgment.continuationMmdFile) {
      await reactivateMmd(judgment.continuationMmdFile);
    } else if (judgment.isLongTask && judgment.newTaskLabel) {
      const newTaskLabel = sanitizeMmdLabel(judgment.newTaskLabel);
      const currentLabel = currentMmd
        ? currentMmd.replace(/^\d+-/, "").replace(/\.mmd$/, "")
        : null;
      if (currentLabel !== newTaskLabel) {
        await createNewMmd(newTaskLabel);
      }
    } else if (judgment.isContinuation && !judgment.continuationMmdFile) {
      if (!currentMmd) {
        stateManager.setActiveMmd(null, null);
      }
    } else {
      logger.debug?.("[context-offload] L1.5: No MMD needed (casual/short), clearing active MMD");
      stateManager.setActiveMmd(null, null);
    }
  } else {
    logger.debug?.(`[context-offload] L1.5: Task NOT completed — continuation=${judgment.isContinuation}, longTask=${judgment.isLongTask}, current=${currentMmd ?? "(none)"}`);
    if (judgment.isContinuation) {
      if (!currentMmd && judgment.continuationMmdFile) {
        await reactivateMmd(judgment.continuationMmdFile);
      }
    } else if (judgment.isLongTask && judgment.newTaskLabel) {
      const newTaskLabel = sanitizeMmdLabel(judgment.newTaskLabel);
      const currentLabel = currentMmd
        ? currentMmd.replace(/^\d+-/, "").replace(/\.mmd$/, "")
        : null;
      if (currentLabel !== newTaskLabel) {
        await createNewMmd(newTaskLabel);
      }
    }
  }
}
