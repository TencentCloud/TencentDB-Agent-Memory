const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

export interface TextPartLike {
  type?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

export interface StripRecallResult<T> {
  value: T;
  removedChars: number;
}

export interface RecallInjectionTurn {
  userText: string;
  prependContext?: string;
}

export interface RecallInjectionImpactTurn {
  turn: number;
  cleanUserChars: number;
  injectedChars: number;
  persistedCharsWithInjected: number;
  persistedCharsWithoutInjected: number;
  extraPersistedChars: number;
  prefixChangesFromPrevious: boolean;
}

export interface RecallInjectionImpact {
  turns: RecallInjectionImpactTurn[];
  totalPersistedCharsWithInjected: number;
  totalPersistedCharsWithoutInjected: number;
  extraPersistedChars: number;
  prefixChangeCount: number;
}

export function stripRelevantMemoriesFromText(text: string): StripRecallResult<string> {
  if (!text.includes("<relevant-memories>")) {
    return { value: text, removedChars: 0 };
  }

  const cleaned = text.replace(RELEVANT_MEMORIES_RE, "").trim();
  return {
    value: cleaned,
    removedChars: text.length - cleaned.length,
  };
}

export function stripRelevantMemoriesFromParts(parts: TextPartLike[]): StripRecallResult<TextPartLike[]> {
  let removedChars = 0;
  const value = parts.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;

    const result = stripRelevantMemoriesFromText(part.text);
    removedChars += result.removedChars;
    return result.removedChars > 0 ? { ...part, text: result.value } : part;
  });

  return { value, removedChars };
}

export function buildInjectedUserText(turn: RecallInjectionTurn): string {
  return turn.prependContext ? `${turn.prependContext}\n\n${turn.userText}` : turn.userText;
}

/**
 * Estimate how persisted injected recall affects future prompt-cache stability.
 *
 * When injected context is written into conversation history, every future turn
 * inherits previous dynamic recall blocks. Prefix-matching providers then see a
 * different historical prefix whenever those blocks differ across turns.
 */
export function analyzeRecallInjectionImpact(turns: RecallInjectionTurn[]): RecallInjectionImpact {
  let previousRecallPrefix = "";
  let totalPersistedCharsWithInjected = 0;
  let totalPersistedCharsWithoutInjected = 0;
  let prefixChangeCount = 0;

  const impactTurns = turns.map((turn, index) => {
    const injectedText = buildInjectedUserText(turn);
    const cleanText = stripRelevantMemoriesFromText(injectedText).value;
    const recallPrefix = turn.prependContext ?? "";
    const prefixChangesFromPrevious = index > 0 && recallPrefix !== previousRecallPrefix;

    if (prefixChangesFromPrevious) {
      prefixChangeCount += 1;
    }

    previousRecallPrefix = recallPrefix;
    totalPersistedCharsWithInjected += injectedText.length;
    totalPersistedCharsWithoutInjected += cleanText.length;

    return {
      turn: index + 1,
      cleanUserChars: cleanText.length,
      injectedChars: Math.max(0, injectedText.length - cleanText.length),
      persistedCharsWithInjected: injectedText.length,
      persistedCharsWithoutInjected: cleanText.length,
      extraPersistedChars: injectedText.length - cleanText.length,
      prefixChangesFromPrevious,
    };
  });

  return {
    turns: impactTurns,
    totalPersistedCharsWithInjected,
    totalPersistedCharsWithoutInjected,
    extraPersistedChars: totalPersistedCharsWithInjected - totalPersistedCharsWithoutInjected,
    prefixChangeCount,
  };
}
