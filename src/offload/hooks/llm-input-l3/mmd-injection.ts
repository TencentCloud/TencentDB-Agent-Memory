/**
 * mmd-injection.ts — Build / remove MMD history-task context injections
 * after aggressive L3 compression deletes offloaded tool calls.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 */
import { listMmds, readMmd } from "../../storage.js";
import { getOffloadEntry } from "../../l3-helpers.js";
import { PLUGIN_DEFAULTS, type OffloadEntry, type PluginConfig, type PluginLogger } from "../../types.js";
import type { OffloadStateManager } from "../../state-manager.js";

export function removeExistingMmdInjections(messages: any[]): number {
  let removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._mmdInjection) { messages.splice(i, 1); removed++; }
  }
  return removed;
}

export async function buildHistoryMmdInjection(
  deletedToolCallIds: string[],
  offloadMap: Map<string, OffloadEntry>,
  offloadEntries: OffloadEntry[],
  stateManager: OffloadStateManager,
  logger: PluginLogger,
  countTokens: (t: string) => number,
  contextWindow: number,
  pluginConfig: Partial<PluginConfig> | undefined,
): Promise<{ injectedMessages: any[]; totalMmdTokens: number; mmdTokenBudget: number; mmdFiles: string[] }> {
  const mmdMaxTokenRatio = pluginConfig?.mmdMaxTokenRatio ?? PLUGIN_DEFAULTS.mmdMaxTokenRatio;
  const mmdTokenBudget = Math.floor(contextWindow * mmdMaxTokenRatio);
  const deletedMmdPrefixes = new Set<string>();
  for (const toolCallId of deletedToolCallIds) {
    const entry = getOffloadEntry(offloadMap, toolCallId);
    if (entry?.node_id) {
      const prefix = entry.node_id.split("-")[0];
      if (prefix) deletedMmdPrefixes.add(prefix);
    }
  }
  if (deletedMmdPrefixes.size === 0) return { injectedMessages: [], totalMmdTokens: 0, mmdTokenBudget, mmdFiles: [] };

  const allMmdFiles = await listMmds(stateManager.ctx);
  const activeMmd = stateManager.getActiveMmdFile();
  const candidateMmds: string[] = [];
  for (const filename of allMmdFiles) {
    const filePrefix = filename.split("-")[0];
    if (deletedMmdPrefixes.has(filePrefix) && filename !== activeMmd) candidateMmds.push(filename);
  }
  if (candidateMmds.length === 0) return { injectedMessages: [], totalMmdTokens: 0, mmdTokenBudget, mmdFiles: [] };

  // Reverse: most recent MMDs first (highest prefix number = most recent task)
  candidateMmds.reverse();

  const injectedMessages: any[] = [];
  const mmdFiles: string[] = [];
  let totalMmdTokens = 0;
  for (const filename of candidateMmds) {
    const mmdContent = await readMmd(stateManager.ctx, filename);
    if (!mmdContent) continue;

    // Try full content first
    const fullText = buildHistoryMmdText(filename, mmdContent);
    const fullTokens = countTokens(fullText);
    if (totalMmdTokens + fullTokens <= mmdTokenBudget) {
      injectedMessages.push({ role: "user", content: [{ type: "text", text: fullText }], _mmdInjection: true });
      totalMmdTokens += fullTokens;
      mmdFiles.push(filename);
      continue;
    }

    // Full content exceeds budget — try meta-only (filename + taskGoal + node summary)
    const metaText = buildHistoryMmdMetaText(filename, mmdContent);
    const metaTokens = countTokens(metaText);
    if (totalMmdTokens + metaTokens <= mmdTokenBudget) {
      logger.debug?.(`[context-offload] History MMD ${filename}: full=${fullTokens} tokens exceeds budget, injecting meta-only (${metaTokens} tokens)`);
      injectedMessages.push({ role: "user", content: [{ type: "text", text: metaText }], _mmdInjection: true });
      totalMmdTokens += metaTokens;
      mmdFiles.push(`${filename}(meta)`);
      continue;
    }

    // Even meta exceeds budget — skip entirely
    logger.debug?.(`[context-offload] History MMD ${filename}: skipped (full=${fullTokens}, meta=${metaTokens}, remaining budget=${mmdTokenBudget - totalMmdTokens})`);
  }

  // Reverse back so oldest appears first in messages (chronological order for LLM)
  injectedMessages.reverse();
  mmdFiles.reverse();

  return { injectedMessages, totalMmdTokens, mmdTokenBudget, mmdFiles };
}

export function buildHistoryMmdText(filename: string, mmdContent: string): string {
  let taskGoal = "";
  const metaMatch = mmdContent.match(/^%%\{\s*(.*?)\s*\}%%/);
  if (metaMatch) {
    try { const meta = JSON.parse(`{${metaMatch[1]}}`); taskGoal = meta.taskGoal || ""; } catch { /* */ }
  }
  return [
    `<history_task_context file="${filename}">`,
    `【历史任务上下文】以下是一个已完成/暂停的历史任务的状态图。`,
    taskGoal ? `**任务目标:** ${taskGoal}` : "",
    ``, "```mermaid", mmdContent, "```", `</history_task_context>`,
  ].filter((line) => line !== "").join("\n");
}

/** Compact meta-only version when full MMD exceeds token budget */
export function buildHistoryMmdMetaText(filename: string, mmdContent: string): string {
  let taskGoal = "";
  const metaMatch = mmdContent.match(/^%%\{\s*(.*?)\s*\}%%/);
  if (metaMatch) {
    try { const meta = JSON.parse(`{${metaMatch[1]}}`); taskGoal = meta.taskGoal || ""; } catch { /* */ }
  }
  // Extract node summaries from mermaid: lines like `001-N1["some label"]`
  const nodePattern = /(\d{3}-N\d+)\["([^"]+)"\]/g;
  const nodes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = nodePattern.exec(mmdContent)) !== null) {
    nodes.push(`${m[1]}: ${m[2]}`);
  }
  // Extract status classes: classDef done/doing/todo + class assignments
  const statusLines: string[] = [];
  const classAssign = /class\s+([\w,-]+)\s+(done|doing|todo)/g;
  while ((m = classAssign.exec(mmdContent)) !== null) {
    statusLines.push(`${m[1]} → ${m[2]}`);
  }
  return [
    `<history_task_context file="${filename}" mode="meta-only">`,
    `【历史任务摘要】以下是一个历史任务的元信息（原图已省略以节省上下文）。`,
    taskGoal ? `**任务目标:** ${taskGoal}` : "",
    `**任务文件:** ${filename}`,
    nodes.length > 0 ? `**节点:** ${nodes.join("; ")}` : "",
    statusLines.length > 0 ? `**状态:** ${statusLines.join("; ")}` : "",
    `</history_task_context>`,
  ].filter((line) => line !== "").join("\n");
}
