/**
 * Report a client-facing model name in place of the upstream one.
 *
 * Pool requests (pool-service.ts) are answered by whichever member the router
 * picked — or by the retry target — so the upstream `model` field names a real
 * endpoint. Runners record the name the client sent on the Hono context and
 * `withClientFacingModel` rewrites every response the runner returns, upstream
 * or synthetic, JSON or SSE.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "./types.js";

declare module "hono" {
  interface ContextVariableMap {
    clientFacingModel: string;
  }
}

type Runner = (c: Context, config: ProxyConfig) => Promise<Response>;

export function withClientFacingModel(runner: Runner): Runner {
  return async (c, config) => {
    const resp = await runner(c, config);
    const model = c.get("clientFacingModel");
    return model ? maskResponseModel(resp, model) : resp;
  };
}

export async function maskResponseModel(resp: Response, model: string): Promise<Response> {
  if (!resp.body) return resp;
  const contentType = resp.headers.get("content-type") ?? "";
  const headers = new Headers(resp.headers);
  headers.delete("content-length");
  if (contentType.includes("text/event-stream")) {
    return new Response(resp.body.pipeThrough(createSseModelMaskStream(model)), {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  }
  if (!contentType.includes("json")) return resp;
  const text = await resp.text();
  return new Response(maskJsonText(text, model), { status: resp.status, statusText: resp.statusText, headers });
}

/** Rewrite `model` (OpenAI, Anthropic) and `message.model` (Anthropic message_start). */
function maskPayload(payload: unknown, model: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const obj = payload as Record<string, unknown>;
  let changed = false;
  if (typeof obj.model === "string" && obj.model !== model) {
    obj.model = model;
    changed = true;
  }
  const message = obj.message as Record<string, unknown> | undefined;
  if (message && typeof message === "object" && typeof message.model === "string" && message.model !== model) {
    message.model = model;
    changed = true;
  }
  return changed;
}

export function maskJsonText(text: string, model: string): string {
  if (!text.includes("\"model\"")) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    return maskPayload(parsed, model) ? JSON.stringify(parsed) : text;
  } catch {
    return text;
  }
}

function maskSseLine(line: string, model: string): string {
  if (!line.startsWith("data:") || !line.includes("\"model\"")) return line;
  const payload = line.slice(5).trimStart();
  try {
    const parsed = JSON.parse(payload) as unknown;
    return maskPayload(parsed, model) ? `data: ${JSON.stringify(parsed)}` : line;
  } catch {
    return line;
  }
}

/** Line-buffered SSE rewrite; events split across chunks are reassembled first. */
export function createSseModelMaskStream(model: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lastNewline = pending.lastIndexOf("\n");
      if (lastNewline < 0) return;
      const complete = pending.slice(0, lastNewline + 1);
      pending = pending.slice(lastNewline + 1);
      controller.enqueue(encoder.encode(complete.split("\n").map((line) => {
        const cr = line.endsWith("\r");
        const body = cr ? line.slice(0, -1) : line;
        return maskSseLine(body, model) + (cr ? "\r" : "");
      }).join("\n")));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(maskSseLine(pending, model)));
    },
  });
}
