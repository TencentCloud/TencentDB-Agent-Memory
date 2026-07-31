/**
 * Conservative rule-based extraction for explicit, high-confidence L1 facts.
 *
 * This intentionally handles only full-message user statements whose meaning
 * is stable without surrounding context. Ambiguous text stays in the normal
 * LLM path; background and assistant messages are never passed here.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { ExtractedMemory, MemoryType } from "./l1-writer.js";

interface DirectRule {
  type: MemoryType;
  priority: number;
  pattern: RegExp;
  format: (value: string) => string;
}

const DIRECT_RULES: DirectRule[] = [
  {
    type: "persona",
    priority: 80,
    pattern: /^(?:我|本人)(?:是|的职业是|的工作是|的岗位是)\s*(.{2,60})[。.!！]?$/u,
    format: (value) => `用户是${value}`,
  },
  {
    type: "persona",
    priority: 70,
    pattern: /^(?:我|本人)(?:很|非常|比较|特别)?(?:喜欢|偏好)\s*(.{2,60})[。.!！]?$/u,
    format: (value) => `用户喜欢${value}`,
  },
  {
    type: "persona",
    priority: 75,
    pattern: /^(?:I am|I'm)\s+(?:an?\s+)?(.{3,80})[.!]?$/iu,
    format: (value) => `The user is ${value}`,
  },
  {
    type: "persona",
    priority: 70,
    pattern: /^I (?:really )?(?:like|prefer)\s+(.{3,80})[.!]?$/iu,
    format: (value) => `The user prefers ${value}`,
  },
  {
    type: "instruction",
    priority: 90,
    pattern: /^(?:以后|从现在开始)(?:都|请|要|务必)?\s*(.{3,80})[。.!！]?$/u,
    format: (value) => `用户要求 AI 以后${value}`,
  },
  {
    type: "instruction",
    priority: 95,
    pattern: /^(?:请)?(?:用|使用)(中文|英文|日文|法文)(?:来)?回复(?:我)?[。.!！]?$/u,
    format: (value) => `用户要求 AI 使用${value}回复`,
  },
  {
    type: "instruction",
    priority: 90,
    pattern: /^(?:Please\s+)?(?:always|from now on)\s+(.{4,100})[.!]?$/iu,
    format: (value) => `The user requires the AI to always ${value}`,
  },
];

const PUNCTUATION_ONLY = /^[\s，。、！？,.!?;；:："'“”‘’()[\]{}]+$/u;

export interface PreExtractionResult {
  direct: ExtractedMemory[];
  remainingMessages: ConversationMessage[];
}

/**
 * Extract only deterministic memories from new user messages.
 *
 * A matched message is removed from the LLM input so the same fact is not
 * extracted twice. Non-matches preserve their original order.
 */
export function preExtractHighConfidence(
  newMessages: ConversationMessage[],
): PreExtractionResult {
  const direct: ExtractedMemory[] = [];
  const remainingMessages: ConversationMessage[] = [];

  for (const message of newMessages) {
    if (message.role !== "user") {
      remainingMessages.push(message);
      continue;
    }

    const match = matchDirectRule(message);
    if (!match) {
      remainingMessages.push(message);
      continue;
    }
    direct.push(match);
  }

  return { direct, remainingMessages };
}

function matchDirectRule(message: ConversationMessage): ExtractedMemory | null {
  const text = message.content.trim();

  for (const rule of DIRECT_RULES) {
    const match = rule.pattern.exec(text);
    const captured = match?.[1]?.trim();
    if (!captured || PUNCTUATION_ONLY.test(captured)) continue;

    return {
      content: rule.format(captured),
      type: rule.type,
      priority: rule.priority,
      source_message_ids: [message.id],
      metadata: {},
      scene_name: "（规则预提取）",
    };
  }

  return null;
}
