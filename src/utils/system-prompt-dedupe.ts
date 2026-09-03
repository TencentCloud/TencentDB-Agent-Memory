import { createHash } from "node:crypto";

type LoggerLike = {
  debug?: (message: string) => void;
};

const TAG = "[memory-tdai] [system-prompt-dedupe]";
const SESSION_PROMPT_MAX_SESSIONS = 1000;
const SESSION_PROMPT_MAX_DIGESTS = 200;

export interface StableSystemPromptAddition {
  source?: string;
  text: string;
}

export interface StableSystemPromptKeptAddition {
  index: number;
  source?: string;
  digest: string;
  chars: number;
  text: string;
}

export interface StableSystemPromptRemovedAddition {
  index: number;
  source?: string;
  digest: string;
  chars: number;
  firstIndex: number;
}

export interface StableSystemPromptDedupeResult {
  text: string | undefined;
  kept: StableSystemPromptKeptAddition[];
  removed: StableSystemPromptRemovedAddition[];
  inputChars: number;
  outputChars: number;
  removedChars: number;
}

export interface SessionSystemPromptShape {
  sessionKey: string;
  turn: number;
  status: "first" | "same" | "changed";
  digest: string;
  previousDigest?: string;
  chars: number;
  firstSeenTurn: number;
  lastSeenTurn: number;
  hitCount: number;
}

interface SessionDigestEntry {
  firstSeenTurn: number;
  lastSeenTurn: number;
  hitCount: number;
  chars: number;
}

interface SessionPromptState {
  turn: number;
  lastDigest?: string;
  digests: Map<string, SessionDigestEntry>;
}

const sessionSystemPromptShapes = new Map<string, SessionPromptState>();

export function digestStableSystemPrompt(text: string): string {
  return createHash("sha256").update(normalizeStableSystemPrompt(text)).digest("hex");
}

export function normalizeStableSystemPrompt(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export function dedupeStableSystemPromptAdditions(
  additions: Array<string | StableSystemPromptAddition | undefined>,
  separator = "\n\n",
): StableSystemPromptDedupeResult {
  const seen = new Map<string, number>();
  const kept: StableSystemPromptKeptAddition[] = [];
  const removed: StableSystemPromptRemovedAddition[] = [];
  let inputChars = 0;
  let outputChars = 0;
  let removedChars = 0;

  for (let index = 0; index < additions.length; index++) {
    const addition = additions[index];
    if (addition == null) continue;

    const source = typeof addition === "string" ? undefined : addition.source;
    const normalized = normalizeStableSystemPrompt(
      typeof addition === "string" ? addition : addition.text,
    );
    if (!normalized) continue;

    inputChars += normalized.length;
    const digest = digestStableSystemPrompt(normalized);
    const firstIndex = seen.get(digest);
    if (firstIndex != null) {
      removed.push({ index, source, digest, chars: normalized.length, firstIndex });
      removedChars += normalized.length;
      continue;
    }

    seen.set(digest, index);
    kept.push({ index, source, digest, chars: normalized.length, text: normalized });
    outputChars += normalized.length;
  }

  const text = kept.length > 0 ? kept.map((item) => item.text).join(separator) : undefined;
  return { text, kept, removed, inputChars, outputChars, removedChars };
}

export function observeSessionSystemPromptShape(
  sessionKey: string,
  stableSystemPrompt: string,
  logger?: LoggerLike,
): SessionSystemPromptShape {
  const normalized = normalizeStableSystemPrompt(stableSystemPrompt);
  const digest = digestStableSystemPrompt(normalized);
  const state = getSessionPromptState(sessionKey);
  state.turn += 1;

  const previousDigest = state.lastDigest;
  const status: SessionSystemPromptShape["status"] = previousDigest == null
    ? "first"
    : previousDigest === digest
      ? "same"
      : "changed";

  let entry = state.digests.get(digest);
  if (!entry) {
    entry = {
      firstSeenTurn: state.turn,
      lastSeenTurn: state.turn,
      hitCount: 0,
      chars: normalized.length,
    };
    state.digests.set(digest, entry);
  }
  entry.lastSeenTurn = state.turn;
  entry.hitCount += 1;
  entry.chars = normalized.length;
  state.lastDigest = digest;

  pruneSessionPromptState(state);
  pruneSessionPromptSessions();

  if (status !== "same") {
    logger?.debug?.(
      `${TAG} session=${sessionKey}, status=${status}, turn=${state.turn}, ` +
      `chars=${normalized.length}, digest=${digest.slice(0, 12)}`,
    );
  }

  return {
    sessionKey,
    turn: state.turn,
    status,
    digest,
    previousDigest,
    chars: normalized.length,
    firstSeenTurn: entry.firstSeenTurn,
    lastSeenTurn: entry.lastSeenTurn,
    hitCount: entry.hitCount,
  };
}

export function resetSessionSystemPromptDedupeForTest(): void {
  sessionSystemPromptShapes.clear();
}

function getSessionPromptState(sessionKey: string): SessionPromptState {
  let state = sessionSystemPromptShapes.get(sessionKey);
  if (!state) {
    state = { turn: 0, digests: new Map() };
    sessionSystemPromptShapes.set(sessionKey, state);
  }
  return state;
}

function pruneSessionPromptState(state: SessionPromptState): void {
  if (state.digests.size <= SESSION_PROMPT_MAX_DIGESTS) return;
  const sorted = [...state.digests.entries()].sort((a, b) => b[1].lastSeenTurn - a[1].lastSeenTurn);
  state.digests = new Map(sorted.slice(0, SESSION_PROMPT_MAX_DIGESTS));
}

function pruneSessionPromptSessions(): void {
  if (sessionSystemPromptShapes.size <= SESSION_PROMPT_MAX_SESSIONS) return;
  const sorted = [...sessionSystemPromptShapes.entries()].sort((a, b) => b[1].turn - a[1].turn);
  sessionSystemPromptShapes.clear();
  for (const [key, value] of sorted.slice(0, SESSION_PROMPT_MAX_SESSIONS)) {
    sessionSystemPromptShapes.set(key, value);
  }
}
