import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { ExtractedMemory } from "./l1-writer.js";

export interface PreExtractionResult {
  memories: ExtractedMemory[];
  canBypassLlm: boolean;
}

type RuleMatch = Omit<ExtractedMemory, "source_message_ids">;

const MAX_DIRECT_MESSAGE_CHARS = 80;

export function preExtractHighConfidenceMemories(messages: ConversationMessage[]): PreExtractionResult {
  const userMessages = messages.filter((message) => message.role === "user");
  const memories: ExtractedMemory[] = [];
  const coveredUserIds = new Set<string>();

  for (const message of userMessages) {
    const match = matchHighConfidenceRule(message.content);
    if (!match) continue;
    memories.push({
      ...match,
      source_message_ids: [message.id],
    });
    coveredUserIds.add(message.id);
  }

  return {
    memories,
    canBypassLlm: memories.length > 0 && userMessages.every((message) => coveredUserIds.has(message.id)),
  };
}

function matchHighConfidenceRule(raw: string): RuleMatch | undefined {
  const text = normalizeDirectText(raw);
  if (!text || text.length > MAX_DIRECT_MESSAGE_CHARS || /[\n\r]/.test(raw)) {
    return undefined;
  }

  return matchPersonaRule(text) ?? matchInstructionRule(text);
}

function matchPersonaRule(text: string): RuleMatch | undefined {
  const identity = text.match(/^我(?:是一名|是一个|是一位|是)\s*(.{2,40})$/u);
  if (identity) {
    return {
      content: `用户是 ${identity[1].trim()}。`,
      type: "persona",
      priority: 80,
      scene_name: "用户介绍个人身份信息",
      metadata: {},
    };
  }

  const occupation = text.match(/^我的(?:职业|工作|岗位)(?:是|为)\s*(.{2,40})$/u);
  if (occupation) {
    return {
      content: `用户的职业是 ${occupation[1].trim()}。`,
      type: "persona",
      priority: 80,
      scene_name: "用户介绍个人身份信息",
      metadata: {},
    };
  }

  const preference = text.match(/^我(喜欢|偏好|擅长)\s*(.{2,40})$/u);
  if (preference) {
    return {
      content: `用户${preference[1]} ${preference[2].trim()}。`,
      type: "persona",
      priority: 70,
      scene_name: "用户介绍个人偏好",
      metadata: {},
    };
  }

  return undefined;
}

function matchInstructionRule(text: string): RuleMatch | undefined {
  const language = text.match(/^以后(?:请|都|要)?\s*(?:用|使用)\s*(.{1,20}?)(?:回复|回答)$/u);
  if (language) {
    return {
      content: `用户要求 AI 以后用${language[1].trim()}回复。`,
      type: "instruction",
      priority: 80,
      scene_name: "用户设置 AI 回复偏好",
      metadata: {},
    };
  }

  const futureDirective = text.match(/^以后(?:请|都|要)?\s*(不要|别|保持|尽量|必须|直接)\s*(.{2,40})$/u);
  if (futureDirective) {
    return {
      content: `用户要求 AI 以后${futureDirective[1]}${futureDirective[2].trim()}。`,
      type: "instruction",
      priority: 80,
      scene_name: "用户设置 AI 回复偏好",
      metadata: {},
    };
  }

  const fromNow = text.match(/^从现在开始(?:请|都|要)?\s*(.{2,50})$/u);
  if (fromNow) {
    return {
      content: `用户要求 AI 从现在开始${fromNow[1].trim()}。`,
      type: "instruction",
      priority: 80,
      scene_name: "用户设置 AI 回复偏好",
      metadata: {},
    };
  }

  return undefined;
}

function normalizeDirectText(text: string): string {
  return text
    .trim()
    .replace(/[。.!！]+$/u, "")
    .replace(/\s+/g, " ");
}
