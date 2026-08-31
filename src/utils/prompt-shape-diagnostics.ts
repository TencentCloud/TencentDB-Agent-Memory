import { createHash } from "node:crypto";

const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>/g;
const HASH_PREFIX_LENGTH = 12;

export type MemoryPromptSegmentName =
  | "appendSystemContext"
  | "history"
  | "prependContext"
  | "appendContext"
  | "currentUserPrompt";

export interface PromptShapeSegment {
  present: boolean;
  chars: number;
  sha256: string;
}

export interface RelevantMemoryBlockShape {
  count: number;
  totalChars: number;
}

export interface MemoryPromptShape {
  appendSystemContext: PromptShapeSegment;
  history: PromptShapeSegment;
  prependContext: PromptShapeSegment;
  appendContext: PromptShapeSegment;
  currentUserPrompt: PromptShapeSegment;
  totalChars: number;
  relevantMemoriesInHistory: RelevantMemoryBlockShape;
}

export interface MemoryPromptShapeDelta {
  firstSample: boolean;
  changedSegments: MemoryPromptSegmentName[];
  unchangedSegments: MemoryPromptSegmentName[];
  totalCharsDelta: number;
  relevantMemoriesInHistoryDelta: number;
}

export function captureMemoryPromptShape(input: {
  appendSystemContext?: string;
  messages?: unknown[];
  prependContext?: string;
  appendContext?: string;
  currentUserPrompt?: string;
}): MemoryPromptShape {
  const historyText = serializePromptMessages(input.messages ?? []);
  const appendSystemContext = shapeText(input.appendSystemContext ?? "");
  const history = shapeText(historyText);
  const prependContext = shapeText(input.prependContext ?? "");
  const appendContext = shapeText(input.appendContext ?? "");
  const currentUserPrompt = shapeText(input.currentUserPrompt ?? "");

  return {
    appendSystemContext,
    history,
    prependContext,
    appendContext,
    currentUserPrompt,
    totalChars:
      appendSystemContext.chars +
      history.chars +
      prependContext.chars +
      appendContext.chars +
      currentUserPrompt.chars,
    relevantMemoriesInHistory: captureRelevantMemoryBlocks(historyText),
  };
}

export function compareMemoryPromptShapes(
  previous: MemoryPromptShape | undefined,
  current: MemoryPromptShape,
): MemoryPromptShapeDelta {
  if (!previous) {
    return {
      firstSample: true,
      changedSegments: [],
      unchangedSegments: [],
      totalCharsDelta: 0,
      relevantMemoriesInHistoryDelta: 0,
    };
  }

  const segmentNames: MemoryPromptSegmentName[] = [
    "appendSystemContext",
    "history",
    "prependContext",
    "appendContext",
    "currentUserPrompt",
  ];
  const changedSegments = segmentNames.filter(
    (name) => previous[name].sha256 !== current[name].sha256,
  );

  return {
    firstSample: false,
    changedSegments,
    unchangedSegments: segmentNames.filter((name) => !changedSegments.includes(name)),
    totalCharsDelta: current.totalChars - previous.totalChars,
    relevantMemoriesInHistoryDelta:
      current.relevantMemoriesInHistory.count -
      previous.relevantMemoriesInHistory.count,
  };
}

export function formatMemoryPromptShapeDiagnostic(
  shape: MemoryPromptShape,
  delta: MemoryPromptShapeDelta,
): string {
  let changed: string;
  if (delta.firstSample) {
    changed = "first-sample";
  } else if (delta.changedSegments.length > 0) {
    changed = delta.changedSegments.join(",");
  } else {
    changed = "none";
  }

  return [
    `total=${shape.totalChars}c`,
    `delta=${formatSigned(delta.totalCharsDelta)}c`,
    `changed=${changed}`,
    formatSegment("appendSystemContext", shape.appendSystemContext),
    formatSegment("history", shape.history),
    formatSegment("prependContext", shape.prependContext),
    formatSegment("appendContext", shape.appendContext),
    formatSegment("currentUserPrompt", shape.currentUserPrompt),
    `historyRelevantMemories=${shape.relevantMemoriesInHistory.count}` +
      `(${shape.relevantMemoriesInHistory.totalChars}c,` +
      `delta=${formatSigned(delta.relevantMemoriesInHistoryDelta)})`,
  ].join(" ");
}

function shapeText(text: string): PromptShapeSegment {
  return {
    present: text.length > 0,
    chars: text.length,
    sha256: hashText(text),
  };
}

function captureRelevantMemoryBlocks(text: string): RelevantMemoryBlockShape {
  const matches = [...text.matchAll(RELEVANT_MEMORIES_RE)].map((match) => match[0]);
  return {
    count: matches.length,
    totalChars: matches.reduce((sum, block) => sum + block.length, 0),
  };
}

function serializePromptMessages(messages: unknown[]): string {
  if (messages.length === 0) return "";
  return stableStringify(messages.map(toPromptVisibleMessage));
}

function toPromptVisibleMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const record = message as Record<string, unknown>;
  return {
    role: record.role,
    content: toPromptVisibleContent(record.content),
  };
}

function toPromptVisibleContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;

  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return { type: "text", text: record.text };
    }
    return normalizeForStableJson(record);
  });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeForStableJson(item, seen));
    seen.delete(value);
    return normalized;
  }

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    normalized[key] = normalizeForStableJson(record[key], seen);
  }
  seen.delete(value);
  return normalized;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function formatSegment(name: MemoryPromptSegmentName, segment: PromptShapeSegment): string {
  return `${name}=${segment.chars}c/${segment.sha256.slice(0, HASH_PREFIX_LENGTH)}`;
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
