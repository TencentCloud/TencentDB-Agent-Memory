import { createLogger } from "../../logger.js";
import { createLlmClient } from "../wiki/ingest-v2/llm.js";
import type { LlmConfig } from "../../config.js";
import type { CodeGraphInstance } from "./bridge.js";
import { executeTool } from "./bridge.js";
import {
  REWRITEABLE_TOOLS,
  emptyHitHint,
  hasCjk,
  isEmptySymbolHit,
  rewriteQueryToIdentifiers,
} from "./query-rewrite.js";

const log = createLogger("code-nl-rewrite");

export type ResolveLlm = (serviceId: string) => LlmConfig;

/**
 * Run a code-graph tool; if explore/search was a CJK question with zero hits,
 * rewrite to identifier tokens via LLM and retry once.
 */
export async function executeCodeToolWithNlRewrite(
  instance: CodeGraphInstance,
  toolName: string,
  params: Record<string, unknown>,
  opts?: { serviceId?: string; resolveLlm?: ResolveLlm },
): Promise<{ text: string; isError: boolean }> {
  const first = await executeTool(instance, toolName, params);
  const query = typeof params.query === "string" ? params.query : "";

  if (
    !REWRITEABLE_TOOLS.has(toolName) ||
    first.isError ||
    !query ||
    !hasCjk(query) ||
    !isEmptySymbolHit(first.text)
  ) {
    return first;
  }

  const chat = tryChat(opts?.serviceId, opts?.resolveLlm);
  if (!chat) {
    return { text: emptyHitHint(query), isError: false };
  }

  let rewritten: string | null = null;
  try {
    rewritten = await rewriteQueryToIdentifiers(query, chat);
  } catch (err) {
    log.warn("query rewrite failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { text: emptyHitHint(query), isError: false };
  }

  if (!rewritten) {
    return { text: emptyHitHint(query), isError: false };
  }

  const retry = await executeTool(instance, toolName, { ...params, query: rewritten });
  if (retry.isError) return retry;
  if (isEmptySymbolHit(retry.text)) {
    return { text: emptyHitHint(query, rewritten), isError: false };
  }
  return {
    text: `Query rewritten: "${query}" → "${rewritten}"\n\n${retry.text}`,
    isError: false,
  };
}

function tryChat(
  serviceId: string | undefined,
  resolveLlm: ResolveLlm | undefined,
): ((params: { system: string; prompt: string; label?: string; maxOutputTokens?: number }) => Promise<string>) | null {
  if (!serviceId || !resolveLlm) return null;
  try {
    const client = createLlmClient(resolveLlm(serviceId));
    return (params) => client.chat(params);
  } catch (err) {
    log.info("skip query rewrite: LLM not configured", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
