/**
 * engine-history-helpers.ts — L1/L1.5 history-context builders used by
 * registerOffload's L1 / L1.5 backend requests.
 * Extracted from index.ts (Group D decomposition).
 */
import { _extractMsgText, _isHeartbeatText, _normalizePromptForCompare } from "./engine-helpers.js";
import type { OffloadStateManager } from "./state-manager.js";

/**
 * Extract recent history messages for L1/L2 context, organized as
 * user-assistant pairs: each user message followed by up to
 * `maxAssistantPerUser` assistant replies from that turn.
 *
 * Scans messages in forward order, skipping MMD injections, heartbeat
 * probes, and the current prompt (to avoid duplication).
 */
export function _extractRecentHistory(messages: any[], currentPrompt: string | null = null, maxAssistantPerUser = 3): string | null {
  const normalizedCurrent = _normalizePromptForCompare(currentPrompt);

  // Collect turns: each turn = { user: string, assistants: string[] }
  const turns: Array<{ user: string; assistants: string[] }> = [];
  let currentTurn: { user: string; assistants: string[] } | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg._mmdContextMessage || msg._mmdInjection) continue;
    const role = msg.role ?? msg.message?.role ?? msg.type;

    if (role === "user") {
      let text = _extractMsgText(msg);
      if (!text || text.length <= 5) continue;
      // Skip heartbeat probes
      if (_isHeartbeatText(text)) { currentTurn = null; continue; }
      text = text.slice(0, 400);
      // Skip current prompt (already in "current msg" section)
      if (normalizedCurrent) {
        const normalizedText = _normalizePromptForCompare(text);
        if (normalizedText === normalizedCurrent || normalizedText.startsWith(normalizedCurrent) || normalizedCurrent.startsWith(normalizedText)) continue;
      }
      // Start a new turn
      currentTurn = { user: text, assistants: [] };
      turns.push(currentTurn);
    } else if (role === "assistant" && currentTurn) {
      if (currentTurn.assistants.length >= maxAssistantPerUser) continue;
      const directText = _extractMsgText(msg);
      if (!directText || directText.length <= 10) continue;
      // Skip heartbeat replies (e.g. "HEARTBEAT_OK")
      if (_isHeartbeatText(directText)) continue;
      currentTurn.assistants.push(directText.slice(0, 400));
    }
  }

  // Keep only the most recent turns (limit total to avoid oversized context)
  const maxTurns = 5;
  const recentTurns = turns.slice(-maxTurns);

  const parts: string[] = [];
  for (const turn of recentTurns) {
    parts.push(`[User]: ${turn.user}`);
    for (const a of turn.assistants) {
      parts.push(`[Assistant]: ${a}`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

export function _buildL1RecentContext(stateManager: OffloadStateManager): string {
  // Skip heartbeat prompts in current msg
  const rawPrompt = stateManager.cachedUserPrompt;
  const isHeartbeat = typeof rawPrompt === "string" && _isHeartbeatText(rawPrompt);
  const currentLine = (!isHeartbeat && typeof rawPrompt === "string" && rawPrompt.trim())
    ? `[User]: ${rawPrompt.slice(0, 500)}`
    : (stateManager.cachedLatestTurnMessages || "(none)");
  const historyBlock = stateManager.cachedRecentHistory || "(none)";
  return `## current msg:\n${currentLine}\n\n## history msg:\n${historyBlock}`;
}

/** L1.5-specific format: history as reference first, latest user message as focus last. */
export function _buildL15RecentContext(stateManager: OffloadStateManager): string {
  const rawPrompt = stateManager.cachedUserPrompt;
  const isHeartbeat = typeof rawPrompt === "string" && _isHeartbeatText(rawPrompt);
  const currentLine = (!isHeartbeat && typeof rawPrompt === "string" && rawPrompt.trim())
    ? `[User]: ${rawPrompt.slice(0, 500)}`
    : (stateManager.cachedLatestTurnMessages || "(none)");
  const historyBlock = stateManager.cachedRecentHistory || "(none)";
  return `历史消息，可作为参考：\n${historyBlock}\n\n最新user message：\n${currentLine}`;
}
