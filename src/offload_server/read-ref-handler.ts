/**
 * Offload Result Reference Handler — bounded recovery of archived tool results.
 */
import type http from "node:http";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { StorageAdapter } from "../core/storage/adapter.js";
import { ReadRefRequestSchema, type ReadRefRequest } from "./schemas.js";
import { buildOffloadBasePath } from "./session-utils.js";

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) encoder = getEncoding("o200k_base");
  return encoder;
}

function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return getEncoder().encode(text).length;
  } catch {
    // Byte length is a conservative upper bound for byte-level BPE tokens.
    return Buffer.byteLength(text, "utf-8");
  }
}

function truncatePrefix(text: string, maxTokens: number): { content: string; truncated: boolean } {
  if (countTokens(text) <= maxTokens) {
    return { content: text, truncated: false };
  }

  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokens(characters.slice(0, mid).join("")) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return {
    content: characters.slice(0, low).join(""),
    truncated: true,
  };
}

function sliceAroundQuery(
  raw: string,
  query: string,
  maxTokens: number,
): { content: string; truncated: boolean; matchFound: boolean } {
  const matchIndex = raw.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex < 0) {
    return { content: "", truncated: false, matchFound: false };
  }

  const characters = Array.from(raw);
  const matchStart = Array.from(raw.slice(0, matchIndex)).length;
  const matchEnd = matchStart + Array.from(raw.slice(matchIndex, matchIndex + query.length)).length;
  const matchText = characters.slice(matchStart, matchEnd).join("");

  if (countTokens(matchText) > maxTokens) {
    const limited = truncatePrefix(matchText, maxTokens);
    return { ...limited, matchFound: true };
  }

  let low = 0;
  let high = Math.max(matchStart, characters.length - matchEnd);
  let bestStart = matchStart;
  let bestEnd = matchEnd;

  while (low <= high) {
    const radius = Math.floor((low + high) / 2);
    const start = Math.max(0, matchStart - radius);
    const end = Math.min(characters.length, matchEnd + radius);
    const candidate = characters.slice(start, end).join("");
    if (countTokens(candidate) <= maxTokens) {
      bestStart = start;
      bestEnd = end;
      low = radius + 1;
    } else {
      high = radius - 1;
    }
  }

  return {
    content: characters.slice(bestStart, bestEnd).join(""),
    truncated: bestStart > 0 || bestEnd < characters.length,
    matchFound: true,
  };
}

export interface ReadRefData {
  result_ref: string;
  content: string;
  truncated: boolean;
  match_found?: boolean;
}

/**
 * Resolve a result reference only when it points to a direct Markdown child
 * of the current session's refs directory.
 */
export function resolveOwnedResultRef(sessionId: string, resultRef: string): string | null {
  const prefix = `${buildOffloadBasePath(sessionId)}/refs/`;
  if (!resultRef.startsWith(prefix)) return null;

  const filename = resultRef.slice(prefix.length);
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    filename === "." ||
    filename === ".." ||
    !filename.endsWith(".md")
  ) {
    return null;
  }
  return resultRef;
}

/**
 * Select and bound content from an archived tool-result reference.
 */
export function sliceRefContent(
  raw: string,
  request: Pick<ReadRefRequest, "query" | "start_line" | "end_line" | "max_tokens">,
): Omit<ReadRefData, "result_ref"> {
  if (request.query) {
    const result = sliceAroundQuery(raw, request.query, request.max_tokens);
    return {
      content: result.content,
      truncated: result.truncated,
      match_found: result.matchFound,
    };
  }

  const lines = raw.split(/\r?\n/u);
  const startIndex = Math.min((request.start_line ?? 1) - 1, lines.length);
  const endIndex = Math.min(request.end_line ?? lines.length, lines.length);
  const selected = lines.slice(startIndex, endIndex).join("\n");
  const limited = truncatePrefix(selected, request.max_tokens);

  return {
    content: limited.content,
    truncated: limited.truncated || startIndex > 0 || endIndex < lines.length,
  };
}

/**
 * Handle POST /v2/offload/read-ref.
 */
export async function handleReadRef(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _auth: { serviceId: string },
  storage: StorageAdapter,
  requestId: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  successEnvelope: <T>(data: T, requestId: string) => unknown,
  errorEnvelope: (code: number, message: string, requestId: string) => unknown,
): Promise<void> {
  const body = await parseJsonBody(req);
  const parsed = ReadRefRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, errorEnvelope(400, parsed.error.message, requestId));
    return;
  }

  const { session_id: sessionId, result_ref: resultRef } = parsed.data;
  const ownedRef = resolveOwnedResultRef(sessionId, resultRef);
  if (!ownedRef) {
    sendJson(res, 404, errorEnvelope(404, "result_ref not found", requestId));
    return;
  }

  const raw = await storage.readFile(ownedRef);
  if (raw === null) {
    sendJson(res, 404, errorEnvelope(404, "result_ref not found", requestId));
    return;
  }

  sendJson(
    res,
    200,
    successEnvelope<ReadRefData>(
      {
        result_ref: ownedRef,
        ...sliceRefContent(raw, parsed.data),
      },
      requestId,
    ),
  );
}
