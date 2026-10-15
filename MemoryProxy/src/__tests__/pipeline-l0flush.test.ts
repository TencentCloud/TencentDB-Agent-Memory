/**
 * Pipeline 级 L0-flush 回归测试（review 意见：接线层回归保护）。
 *
 * 与 l0-flush-fix.test.ts（直接 import createUsageTapTransform、自搭 tee）不同，
 * 本测试走 runOpenaiChatPipeline 的真实调用点：stub 上游（stageForwardWithRetry
 * 返回带 SSE body 的 Response）、客户端读完第一块即 cancel（Hermes 工具轮形态）、
 * 断言 finalize 的落库副作用发生（notifyUpstreamResponse / recordTdaiTurn 被调且
 * 内容完整）——9/9、10/9 两回失手都在接线层（tee/startAudit 被删套件照样全绿），
 * 此测试兜住"掉接线 + 提前断连"的失败形态（L0 无声消失、零日志零红测试）。
 *
 * @package tencentdb-agent-memory-tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock 面：重副作用 / 鉴权 / 路由 / 上游（pipeline 接线层保持真实）────────
vi.mock("../logger.js", () => ({
  writeLog: vi.fn(),
  createPipeline: () => {
    const p = {
      error: vi.fn(),
      info: vi.fn(), warn: vi.fn(),
      requestReceived: vi.fn(), requestFinished: vi.fn(), streamStart: vi.fn(),
      streamDone: vi.fn(), forwardStart: vi.fn(), forwardDone: vi.fn(), forwardError: vi.fn(),
      ids: () => ({}),
    };
    return p;
  },
}));
vi.mock("../opik.js", () => ({
  apiKeyToKeyId: (k: string) => k,
  extractBearerToken: (h: string) => h,
  opikCreateLlmSpan: vi.fn(), opikCreateTrace: vi.fn(), opikUpdateTrace: vi.fn(),
  uuidv7: () => "test-trace-uuid",
}));
vi.mock("../langfuse.js", () => ({
  langfuseReportGeneration: vi.fn(), langfuseReportFailure: vi.fn(), langfuseTurnTraceId: vi.fn(),
}));
vi.mock("../common/langfuse-debug.js", () => ({
  buildLangfuseInputChat: () => [], buildRequestDebugMetadata: () => ({}),
}));
vi.mock("../turnSeq.js", () => ({
  countHumanTurns: () => 0, resolveMonotonicTurnSeq: () => 1,
}));
vi.mock("../routes/whitelist.js", () => ({
  hasCostGuardMarker: () => false, isLegacyProxyPath: () => false,
  matchWhitelistEndpoint: () => false, resolveCostGuardMode: () => "disabled",
}));
vi.mock("../requestLog.js", () => ({ writeRequestLog: vi.fn() }));
vi.mock("../request-prepare-adapter.js", () => ({
  prepareUpstreamRequest: async () => ({}),
  notifyUpstreamResponse: vi.fn(),
}));
vi.mock("../clickhouse.js", () => ({ writeFailedReportRaw: vi.fn() }));
vi.mock("../credit-reporter.js", () => ({
  tryReportCreditFromPath: () => undefined, extractSpaceIdFromPath: () => "default",
}));
vi.mock("../pricing.js", () => ({ resolveModelId: (m: string) => m, isModelInPricing: () => true }));
vi.mock("../identity.js", () => ({ inspectAndRecord: vi.fn() }));
vi.mock("../auth.js", () => ({ verifyUserKey: async () => ({ userId: "usr-test", rejected: false }) }));
vi.mock("../mainModel.js", () => ({ applyMainModel: () => undefined }));
vi.mock("../pool-service.js", () => ({
  applyPoolService: () => ({ clientFacingModel: undefined, routed: false, model: "deepseek-v4-flash" }),
}));
vi.mock("../guard-adapter.js", () => ({
  resolveForwardTarget: () => undefined, resolveSessionKey: () => "sess-test",
  resolveLatestUserQuery: () => "hi", reportAnalyzerTrace: vi.fn(),
}));
vi.mock("../instance-upstream-cache.js", () => ({}));
vi.mock("../common/constants.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../common/constants.js")>();
  return { ...orig, SKIP_REQUEST_HEADERS_HOP_BY_HOP: new Set() };
});
vi.mock("../common/cfq-strip.js", () => ({
  createCfqStripStream: () => new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) { c.enqueue(chunk); },
  }),
  createCfqStripObserver: () => ({}),
}));
vi.mock("../systemUser.js", () => ({ matchSystemUserByUserId: () => false, hasSystemUsers: () => false }));
vi.mock("../systemUserPassthrough.js", () => ({ handleSystemUserPassthrough: vi.fn() }));
vi.mock("../wecom-identity-form.js", () => ({ requireWecomIdentity: () => null }));
vi.mock("../tdai/client.js", () => ({ TdaiClient: class {}, buildTdaiClientForRequest: () => ({}) }));
vi.mock("../tdai/identity.js", () => ({ deriveTdaiIdentity: () => null }));
vi.mock("../tdai/recorder.js", () => ({
  extractLatestUserMessage: () => "hi",
  recordTdaiTurn: vi.fn(),
}));
vi.mock("../tdai/pending-writes.js", () => ({
  trackWrite: (p: Promise<void>) => void p,
  withL0Retry: (fn: () => Promise<void>) => fn(),
}));
vi.mock("../agent-adapters/opencode.js", () => ({ opencodeAdapter: vi.fn() }));
vi.mock("../skill/handler-glue.js", () => ({ triggerSkillExtractIfReady: vi.fn() }));
vi.mock("../session/model-intent-telemetry.js", () => ({ emitModelIntentTelemetry: vi.fn() }));
vi.mock("../extraction-gate.js", () => ({
  isExtractionAllowed: () => true, logExtractionSkipped: vi.fn(),
}));
vi.mock("../pipeline/stages/auth.js", () => ({
  stageAuth: async () => ({ apiKey: "sk-test", keyId: "k-test", userId: "usr-test", spaceId: "default", rejected: false }),
}));
vi.mock("../pipeline/stages/parse-body.js", () => ({
  stageParseBody: async () => ({
    ok: true,
    body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true },
  }),
}));
vi.mock("../pipeline/stages/model-gate.js", () => ({
  stageModelGate: async () => ({ rejected: false }),
  buildUnregisteredModelErrorBody: () => new Response("model error", { status: 400 }),
}));
vi.mock("../pipeline/stages/credit.js", () => ({ stageCredit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../pipeline/stages/system-user.js", () => ({ stageSystemUser: async () => undefined }));
vi.mock("../pipeline/stages/observability.js", () => ({
  stageBuildLangfuseTurnContext: async () => ({
    turnSeq: 1,
    lf: { turnSeq: 1, traceId: "t1", traceName: "trace", userId: "usr-test", sessionId: "sess-test", tags: [], userQuery: "hi", instanceId: undefined },
  }),
  stageReportAnalyzerTrace: vi.fn(),
}));
vi.mock("../pipeline/stages/turn-seq.js", () => ({ stageResolveTurnSeq: async () => ({ turnSeq: 1 }) }));
vi.mock("../pipeline/stages/session-reset-pre-hook.js", () => ({ stageSessionResetPreHook: async () => undefined }));
vi.mock("../pipeline/stages/session-reset-confirmation.js", () => ({ stageSessionResetConfirmation: async () => undefined }));
vi.mock("../pipeline/stages/mem-command-intercept.js", () => ({ stageMemCommandIntercept: async () => undefined }));
vi.mock("../pipeline/stages/stream-finalize.js", () => ({
  stageWriteUsageLog: vi.fn(), stageRecordTokenUsage: vi.fn(),
  stageEmitModelIntent: vi.fn(), stageOpikStreamSpan: vi.fn(),
}));
vi.mock("../pipeline/stages/prewarm-injection.js", () => ({ stagePrewarmInjection: async () => ({}) }));
vi.mock("../pipeline/stages/asset-capabilities.js", () => ({ stageAssetCapabilities: async () => ({ assetCapabilities: undefined }) }));
vi.mock("../pipeline/stages/session-bypass.js", () => ({ stageSessionBypass: async () => ({}) }));
vi.mock("../pipeline/stages/session-init-orchestrate.js", () => ({ stageSessionInitOrchestrate: async () => ({ proceed: true, initResult: {} }) }));
vi.mock("../pipeline/stages/injection-runner.js", () => ({ stageInjectionRunner: async (input: any) => ({ body: input.body, messages: input.messages }) }));
vi.mock("../pipeline/stages/instance-upstream-early.js", () => ({ stageInstanceUpstreamEarly: async () => ({}) }));
vi.mock("../pipeline/stages/instance-upstream-override.js", () => ({ stageInstanceUpstreamOverride: async () => ({}) }));
vi.mock("../pipeline/stages/resolve-target-full.js", () => ({
  stageResolveTargetFull: async () => ({
    target: {
      url: "http://upstream.test/v1", model: "deepseek-v4-flash", apiKey: "sk-test",
      headers: { "content-type": "application/json" }, routedFrom: "", tags: [],
      logMeta: {}, retryTarget: undefined, isCustomUpstream: false, rateLimit: undefined,
    },
  }),
}));
vi.mock("../pipeline/stages/resolve-user-id.js", () => ({ stageResolveUserId: async () => "usr-test" }));
vi.mock("../pipeline/stages/forward-with-retry.js", () => ({
  stageForwardWithRetry: async () => ({ resp: makeUpstreamResponse(), retried: false }),
}));
vi.mock("../pipeline/strategies/agent/index.js", () => ({
  resolveAgentStrategy: () => ({ stageGates: {} }),
}));

// 真实实现 + 副作用 spy
import { runOpenaiChatPipeline } from "../pipeline/runners/openai-chat.js";
import { notifyUpstreamResponse } from "../request-prepare-adapter.js";
import { recordTdaiTurn } from "../tdai/recorder.js";

const enc = (s: string) => new TextEncoder().encode(s);
const sse = (data: string) => `data: ${data}\n\n`;

/** OpenAI 流式上游：3 段 content + DONE */
function makeUpstreamResponse(): Response {
  const chunks = [
    enc(sse(JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }))),
    enc(sse(JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }))),
    enc(sse(JSON.stringify({ choices: [{ delta: { content: " world" } }] }))),
    enc(sse("[DONE]")),
  ];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const c of chunks) controller.enqueue(c); controller.close(); },
  }), { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req-test" } });
}

// notifyUpstreamResponse / recordTdaiTurn 的 spy 必须在 import 后取 vi.mocked 引用
const notify = vi.mocked(notifyUpstreamResponse);
const record = vi.mocked(recordTdaiTurn);

beforeEach(() => {
  vi.clearAllMocks();
});

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("pipeline 级 L0-flush 接线回归（review 意见）", () => {
  it("客户端提前 cancel（工具轮形态）：audit 读完上游，finalize 落库副作用发生且内容完整", async () => {
    const { Context } = await import("hono");
    const c = new Context(new Request("http://x/hermes/default/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));

    const resp = await runOpenaiChatPipeline(c as never, {
        upstream: { url: "http://upstream.test/v1" },
        langfuse: { debug: false },
        opik: { enabled: false },
        creditPricing: {}, injection: {}, redis: { enabled: false },
        server: {}, sessionInit: {}, tdai: {}, md: {},
      } as never) as unknown as Response;

    // 客户端：只读第一块就 cancel（模拟 SDK 解析完 tool_calls 即断开）
    const reader = (resp as Response).body!.getReader();
    await reader.read();
    await reader.cancel();

    // finalize 落库副作用：notifyUpstreamResponse（扩展侧完整响应）+ recordTdaiTurn（L0 安排）
    await waitFor(() => notify.mock.calls.length > 0 && record.mock.calls.length > 0);

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0][1] as { text: string; truncated: boolean };
    expect(payload.text).toBe("Hello world"); // 内容完整（audit 读完 3 段）
    expect(payload.truncated).toBe(false);    // 无超时，无截断标记
    expect(record).toHaveBeenCalledTimes(1);  // L0 写入被安排（trackWrite 到达 recordTdaiTurn）
  }, 20000);

  it("客户端完整消费：flush 与 audit 双触发 finalize 恰 1 次（幂等闸门）", async () => {
    const { Context } = await import("hono");
    const c = new Context(new Request("http://x/hermes/default/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));

    const resp = await runOpenaiChatPipeline(c as never, {
        upstream: { url: "http://upstream.test/v1" },
        langfuse: { debug: false },
        opik: { enabled: false },
        creditPricing: {}, injection: {}, redis: { enabled: false },
        server: {}, sessionInit: {}, tdai: {}, md: {},
      } as never);
    const reader = resp.body!.getReader();
    let text = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    await waitFor(() => notify.mock.calls.length > 0);

    expect(notify).toHaveBeenCalledTimes(1); // audit + flush 双路径只 finalize 1 次
    expect(record).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0][1] as { text: string };
    expect(payload.text).toBe("Hello world");
  }, 20000);
});
