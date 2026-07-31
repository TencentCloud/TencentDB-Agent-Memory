/**
 * Conservative post-LLM validation for extracted L1 memories.
 *
 * The validator only rejects outputs with clear evidence problems. It does not
 * score or rewrite memories, and it does not apply to deterministic
 * pre-extraction results.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { ExtractedMemory } from "./l1-writer.js";

export interface L1ConfidenceResult {
  accepted: boolean;
  reason?: string;
}

const ENGLISH_STOP_WORDS = new Set([
  "about", "after", "again", "also", "always", "assistant", "before",
  "from", "have", "into", "should", "that", "their", "there", "they",
  "this", "user", "want", "with", "would",
]);

const CJK_STRUCTURAL_BIGRAMS = new Set([
  "用户", "要求", "希望", "以后", "回答", "回复", "助手", "记忆",
]);

/**
 * Validate one LLM-produced memory against the new-message evidence window.
 */
export function validateLlmMemory(
  memory: ExtractedMemory,
  newMessages: ConversationMessage[],
): L1ConfidenceResult {
  const content = memory.content.trim();
  if (!hasMinimumContent(content)) {
    return { accepted: false, reason: "content-too-short" };
  }

  const typeResult = validateTypeShape(memory);
  if (!typeResult.accepted) return typeResult;

  const messageById = new Map(
    newMessages
      .filter((message) => message.role === "user")
      .map((message) => [message.id, message]),
  );
  const declaredIds = [...new Set(memory.source_message_ids.filter(Boolean))];
  const evidenceMessages = declaredIds.length > 0
    ? declaredIds.map((id) => messageById.get(id)).filter((message): message is ConversationMessage => !!message)
    : newMessages.filter((message) => message.role === "user");

  if (declaredIds.length > 0 && evidenceMessages.length !== declaredIds.length) {
    return { accepted: false, reason: "unknown-source-message-id" };
  }
  if (evidenceMessages.length === 0) {
    return { accepted: false, reason: "no-source-evidence" };
  }

  const evidence = evidenceMessages.map((message) => message.content).join("\n");
  if (!hasEvidenceOverlap(content, evidence)) {
    return { accepted: false, reason: "no-evidence-overlap" };
  }

  return { accepted: true };
}

function hasMinimumContent(content: string): boolean {
  const cjkCount = content.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0;
  if (cjkCount > 0) return cjkCount >= 4;

  const latinOrDigitCount = content.match(/[a-z0-9]/giu)?.length ?? 0;
  return latinOrDigitCount >= 12;
}

function validateTypeShape(memory: ExtractedMemory): L1ConfidenceResult {
  const content = memory.content.trim();

  if (memory.type === "persona") {
    if (!/(?:用户|本人|\bthe user\b|\buser\b)/iu.test(content)) {
      return { accepted: false, reason: "persona-missing-user-anchor" };
    }
  }

  if (memory.type === "instruction") {
    const hasActor = /(?:用户|本人|\bthe user\b|\buser\b)/iu.test(content);
    const hasTarget = /(?:\bAI\b|助手|\bassistant\b)/iu.test(content);
    const hasDirective = /(?:要求|希望|必须|以后|始终|禁止|\brequires?\b|\basks?\b|\bwants?\b|\bmust\b|\balways\b|\bnever\b)/iu.test(content);
    if (!hasActor || !hasTarget || !hasDirective) {
      return { accepted: false, reason: "instruction-missing-directive-shape" };
    }
  }

  if (
    memory.type === "episodic" &&
    /^(?:用户)?(?:询问|讨论|咨询|聊)(?:了)?(?:关于)?|^(?:the )?user (?:asked|talked|discussed) about/iu.test(content)
  ) {
    return { accepted: false, reason: "episodic-trivial-boilerplate" };
  }

  return { accepted: true };
}

function hasEvidenceOverlap(content: string, evidence: string): boolean {
  const contentEnglish = englishTokens(content);
  const evidenceEnglish = englishTokens(evidence);
  if (contentEnglish.size > 0) {
    let matches = 0;
    for (const token of contentEnglish) {
      if (evidenceEnglish.has(token)) matches++;
    }
    if (matches >= Math.max(1, Math.ceil(contentEnglish.size * 0.4))) return true;
  }

  const contentCjk = cjkBigrams(content);
  const evidenceCjk = cjkBigrams(evidence);
  if (contentCjk.size > 0) {
    let matches = 0;
    for (const bigram of contentCjk) {
      if (evidenceCjk.has(bigram)) matches++;
    }
    if (matches >= Math.max(1, Math.ceil(contentCjk.size * 0.4))) return true;
  }

  return false;
}

function englishTokens(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/gu) ?? [];
  return new Set(tokens.filter((token) => !ENGLISH_STOP_WORDS.has(token)));
}

function cjkBigrams(text: string): Set<string> {
  const result = new Set<string>();
  const runs = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu) ?? [];

  for (const run of runs) {
    const chars = Array.from(run);
    for (let i = 0; i < chars.length - 1; i++) {
      const bigram = chars[i] + chars[i + 1];
      if (!CJK_STRUCTURAL_BIGRAMS.has(bigram)) result.add(bigram);
    }
  }

  return result;
}
