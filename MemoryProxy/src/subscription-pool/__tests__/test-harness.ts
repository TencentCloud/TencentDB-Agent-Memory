/**
 * Shared helpers for subscription pool tests: a config without YAML side effects, a Hono app
 * that mounts the real runners, and a recording replacement for global fetch.
 */
import { Hono } from "hono";
import { vi } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import type { ProxyConfig } from "../../types.js";
import { runCodexPipeline } from "../../pipeline/runners/codex.js";
import { runUtilityPipeline } from "../../pipeline/runners/utility.js";
import { runAnthropicPipeline } from "../../pipeline/runners/anthropic.js";
import { runOpenaiChatPipeline } from "../../pipeline/runners/openai-chat.js";
import { clearCache } from "../../instance-upstream-cache.js";
import { __resetProxyStorageForTests } from "../../storage/factory.js";
import { clearAccountCache } from "../account-cache.js";
import { resetReporterForTests } from "../reporter.js";

export const CORE_URL = "http://core.test";

export function makeConfig(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.coreSkill.endpoint = CORE_URL;
  config.coreSkill.serviceToken = "svc-token";
  config.upstream.url = "http://global-upstream.test/v1";
  config.upstream.apiKey = "";
  config.log.file = "";
  config.clickhouse.enabled = false;
  config.storage.backend = "memory";
  return config;
}

export function makeApp(config: ProxyConfig): Hono {
  const app = new Hono();
  app.post("/codex/:spaceId/v1/responses/compact", (c) => runCodexPipeline(c, config));
  app.post("/codex/:spaceId/v1/responses", (c) => runCodexPipeline(c, config));
  app.post("/codex/:spaceId/v1/embeddings", (c) => runUtilityPipeline(c, config));
  app.post("/claude-code/:spaceId/v1/messages", (c) => runAnthropicPipeline(c, config));
  app.post("/codebuddy/:spaceId/v1/chat/completions", (c) => runOpenaiChatPipeline(c, config));
  app.post("/claude-code/:spaceId/v1/messages/count_tokens", (c) => runUtilityPipeline(c, config));
  return app;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type FetchHandler = (call: RecordedCall, index: number) => Response | Promise<Response>;

/** Replaces global fetch. Calls to the Core stub URL are answered by `core`, others by `upstream`. */
export function installFetch(
  upstream: FetchHandler,
  core?: (call: RecordedCall) => Response | Promise<Response>,
): { upstreamCalls: RecordedCall[]; coreCalls: RecordedCall[] } {
  const upstreamCalls: RecordedCall[] = [];
  const coreCalls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "",
    };
    if (url.startsWith(CORE_URL)) {
      coreCalls.push(call);
      if (core) return core(call);
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    upstreamCalls.push(call);
    return upstream(call, upstreamCalls.length - 1);
  });
  return { upstreamCalls, coreCalls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Reset every module-level cache so tests do not see each other. */
export function resetPoolState(): void {
  clearCache();
  clearAccountCache();
  resetReporterForTests();
  __resetProxyStorageForTests();
}
