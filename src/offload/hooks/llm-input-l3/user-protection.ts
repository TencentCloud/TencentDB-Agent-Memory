/**
 * user-protection.ts — Helpers that protect the most recent user message
 * from being deleted by aggressive / emergency compression.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 */

/**
 * Find the index of the LAST real user message (not MMD/injection) in the
 * messages array.  Returns -1 if none found.
 *
 * Both aggressive and emergency compression delete from the HEAD of the array
 * (oldest → newest).  By capping deleteCount so it never reaches or exceeds
 * this index, the user's most recent prompt is preserved.
 */
export function findLastUserMessageIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m._mmdContextMessage || m._mmdInjection) continue;
    const role = m.role ?? m.message?.role ?? m.type;
    if (role === "user") return i;
  }
  return -1;
}

/**
 * Cap a head-of-array deleteCount so it does NOT delete the LAST real user
 * message (the most recent user input).  Older user messages in the head
 * region ARE allowed to be deleted — only the final user message is sacred.
 *
 * If the last user message sits at or before `deleteCount`, shrink
 * deleteCount to stop just before it.
 *
 * SPECIAL CASE: When the last user message is at index 0 (i.e. only one
 * user message, at the head), there's nothing deletable before it so we
 * return 0.  The caller (aggressive/emergency) should detect this and
 * fall through to emergency which can handle this scenario differently.
 */
export function capDeleteCountForUserMessage(messages: any[], deleteCount: number): number {
  if (deleteCount <= 0) return 0;
  const lastUserIdx = findLastUserMessageIndex(messages);
  if (lastUserIdx < 0) return deleteCount;           // no user msg → nothing to protect
  if (deleteCount <= lastUserIdx) return deleteCount; // last user msg is safe beyond the cut
  // Shrink to just before the LAST user message (older user msgs can be deleted)
  return lastUserIdx;
}
