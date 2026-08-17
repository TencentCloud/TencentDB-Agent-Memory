import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { MemoryClient, SkillClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { redactText, truncateUtf8 } from "./security.js";

const MAX_RESULT_BYTES = 12_000;
const MIN_SEARCH_LIMIT = 1;
export const MAX_SEARCH_LIMIT = 20;
export const MAX_SEARCH_QUERY_CHARS = 2_000;
export const MAX_SESSION_KEY_CHARS = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const UNTRUSTED_MEMORY_OPEN = '<tdai_untrusted_memory trust="untrusted" purpose="reference-only">';
const UNTRUSTED_MEMORY_CLOSE = "</tdai_untrusted_memory>";

export interface MemorySearchParams {
  query: string;
  limit?: number;
  type?: string;
}

export interface ConversationSearchParams {
  query: string;
  limit?: number;
  session_key?: string;
}

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  const prefix = `${UNTRUSTED_MEMORY_OPEN}\n`;
  const suffix = `\n${UNTRUSTED_MEMORY_CLOSE}`;
  const bodyBudget = MAX_RESULT_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  const body = truncateUtf8(escapeBoundaryText(redactText(text)), bodyBudget);
  return { content: [{ type: "text", text: `${prefix}${body}${suffix}` }], details };
}

export function memorySearchMessage(text: string): AgentToolResult<Record<string, unknown>> {
  return textResult(text);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function escapeBoundaryText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function score(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function normalizeQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const query = value.trim();
  if (!query || query.length > MAX_SEARCH_QUERY_CHARS) return undefined;
  return query;
}

function normalizeLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(MIN_SEARCH_LIMIT, Math.trunc(value)));
}

function normalizeSessionKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(CONTROL_CHARACTERS, "").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_SESSION_KEY_CHARS);
}

export async function memorySearch(
  memory: MemoryClient,
  params: MemorySearchParams,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const query = normalizeQuery(params.query);
  if (!query) {
    return textResult(
      typeof params.query === "string" && params.query.trim().length > MAX_SEARCH_QUERY_CHARS
        ? `Query must not exceed ${MAX_SEARCH_QUERY_CHARS} characters.`
        : "Query cannot be empty.",
    );
  }
  try {
    const limit = normalizeLimit(params.limit);
    const request = {
      query,
      ...(limit === undefined ? {} : { limit }),
      ...(params.type === undefined ? {} : { type: params.type }),
    };
    const result = await memory.searchAtomic(request);
    if (result.items.length === 0) return textResult("No matching memories found.", { count: 0 });
    const lines = result.items.map((item) => `- [${item.type}] (score: ${score(item.score)}) ${item.content}`);
    return textResult(lines.join("\n"), { count: result.items.length });
  } catch (error) {
    return textResult(`Memory search failed: ${safeErrorMessage(error)}`);
  }
}

export async function conversationSearch(
  memory: MemoryClient,
  params: ConversationSearchParams,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const query = normalizeQuery(params.query);
  if (!query) {
    return textResult(
      typeof params.query === "string" && params.query.trim().length > MAX_SEARCH_QUERY_CHARS
        ? `Query must not exceed ${MAX_SEARCH_QUERY_CHARS} characters.`
        : "Query cannot be empty.",
    );
  }
  try {
    const limit = normalizeLimit(params.limit);
    const sessionKey = normalizeSessionKey(params.session_key);
    const result = await memory.searchConversation({
      query,
      ...(limit === undefined ? {} : { limit }),
      ...(sessionKey === undefined ? {} : { session_id: sessionKey }),
    });
    if (result.messages.length === 0) return textResult("No matching conversation messages found.", { count: 0 });
    const lines = result.messages.map((message) => {
      const timestamp = message.timestamp ? ` [${message.timestamp}]` : "";
      return `- [${message.role}]${timestamp} ${message.content}`;
    });
    return textResult(lines.join("\n"), { count: result.messages.length });
  } catch (error) {
    return textResult(`Memory search failed: ${safeErrorMessage(error)}`);
  }
}

export interface SkillSearchParams {
  query: string;
  top_k?: number;
  scope?: string;
}

export interface SkillReadParams {
  skill_id: string;
  path?: string;
}

function normalizeSkillId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_CHARACTERS, "").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_SESSION_KEY_CHARS);
}

function normalizeSkillPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_CHARACTERS, "").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_SESSION_KEY_CHARS);
}

export async function skillSearch(
  skill: SkillClient,
  params: SkillSearchParams,
  allowTeamSearch: boolean,
  routingMode: "bm25" | "embedding" | "hybrid",
): Promise<AgentToolResult<Record<string, unknown>>> {
  const query = normalizeQuery(params.query);
  if (!query) {
    return textResult(
      typeof params.query === "string" && params.query.trim().length > MAX_SEARCH_QUERY_CHARS
        ? `Query must not exceed ${MAX_SEARCH_QUERY_CHARS} characters.`
        : "Query cannot be empty.",
    );
  }
  try {
    const topK = normalizeLimit(params.top_k);
    const scope = params.scope === "team" && allowTeamSearch ? "team" : undefined;
    const result = await skill.search({
      query,
      ...(topK === undefined ? {} : { top_k: topK }),
      mode: routingMode,
      ...(scope === undefined ? {} : { scope }),
    });
    if (result.items.length === 0) return textResult("No matching skills found.", { count: 0 });
    const lines = result.items.map((item) => {
      const name = item.name || "unnamed";
      const description = item.description ? ` — ${item.description}` : "";
      const snippet = item.snippet ? `\n    ${item.snippet}` : "";
      return `- ${name} (v${item.version})${description}${snippet}`;
    });
    return textResult(lines.join("\n"), { count: result.items.length });
  } catch (error) {
    return textResult(`Skill search failed: ${safeErrorMessage(error)}`);
  }
}

export async function skillRead(
  skill: SkillClient,
  params: SkillReadParams,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const skillId = normalizeSkillId(params.skill_id);
  if (!skillId) return textResult("skill_id cannot be empty.");
  try {
    const path = normalizeSkillPath(params.path);
    let content: string;
    if (!path || path === "SKILL.md") {
      const detail = await skill.get({ skill_id: skillId, include_content: true, include_manifest: false });
      content = detail.content ?? "";
    } else {
      const file = await skill.readFile({ skill_id: skillId, path });
      content = file.content;
    }
    if (!content) return textResult("No content found.", { skill_id: skillId });
    return textResult(content, { skill_id: skillId });
  } catch (error) {
    return textResult(`Skill read failed: ${safeErrorMessage(error)}`);
  }
}
