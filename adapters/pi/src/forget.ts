import type { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { redactText, truncateUtf8 } from "./security.js";

/** How many L1 memories and L0 messages a single forget search may return. */
const SEARCH_LIMIT = 10;
/** Preview length for each candidate shown in the confirmation dialog. */
const PREVIEW_BYTES = 200;

export interface ForgetCandidate {
  id: string;
  kind: "L1" | "L0";
  /** `L1` uses "memory"; `L0` carries the conversation role. */
  role: string;
  /** Redacted, bounded preview content for display. */
  content: string;
}

export interface ForgetDeleteResult {
  l1Deleted: number;
  l0Deleted: number;
}

/**
 * Search both L1 atomic memories and L0 conversation evidence for the given
 * query. Returned content is redacted for display; only items with a stable id
 * are candidates for deletion.
 */
export async function searchForgetCandidates(memory: MemoryClient, query: string): Promise<ForgetCandidate[]> {
  const [atomic, conversation] = await Promise.all([
    memory.searchAtomic({ query, limit: SEARCH_LIMIT }),
    memory.searchConversation({ query, limit: SEARCH_LIMIT }),
  ]);

  const candidates: ForgetCandidate[] = [];
  for (const item of atomic.items) {
    const content = redactText(item.content).trim();
    if (!content) continue;
    candidates.push({ id: item.id, kind: "L1", role: "memory", content });
  }
  for (const message of conversation.messages) {
    if (!message.id) continue;
    const content = redactText(message.content).trim();
    if (!content) continue;
    candidates.push({ id: message.id, kind: "L0", role: message.role, content });
  }
  return candidates;
}

/** Render redacted, truncated previews for a confirmation dialog. */
export function formatForgetCandidates(candidates: ForgetCandidate[]): string[] {
  return candidates.map((candidate, index) => {
    const kind = candidate.kind === "L1" ? "[L1 memory]" : `[L0 ${candidate.role}]`;
    return `${index + 1}. ${kind} ${truncateUtf8(candidate.content, PREVIEW_BYTES)}`;
  });
}

/**
 * Delete the selected L1 atomic memories and L0 conversation messages. Each
 * call is independent and best-effort; failures surface to the caller rather
 * than silently dropping the other layer.
 */
export async function deleteForgetCandidates(
  memory: MemoryClient,
  candidates: ForgetCandidate[],
): Promise<ForgetDeleteResult> {
  const l1Ids = [...new Set(candidates.filter((c) => c.kind === "L1").map((c) => c.id))];
  const l0Ids = [...new Set(candidates.filter((c) => c.kind === "L0").map((c) => c.id))];

  let l1Deleted = 0;
  let l0Deleted = 0;
  if (l1Ids.length > 0) {
    const result = await memory.deleteAtomic({ ids: l1Ids });
    l1Deleted = result.deleted_count ?? l1Ids.length;
  }
  if (l0Ids.length > 0) {
    const result = await memory.deleteConversation({ message_ids: l0Ids });
    l0Deleted = result.deleted_count ?? l0Ids.length;
  }
  return { l1Deleted, l0Deleted };
}
