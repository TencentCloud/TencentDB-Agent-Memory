/** Hono app factory — registers all routes. */

import { Hono } from "hono";
import { handleChatCompletions } from "./handler.js";
import { handleAnthropicMessages } from "./anthropicHandler.js";
import { handleAuxiliaryEndpoint } from "./auxiliaryHandler.js";
import { handleCodexEndpoint } from "./codexHandler.js";
import { handleWorkbuddyEndpoint } from "./workbuddyHandler.js";
import { apiKeyToKeyId, extractBearerToken } from "./opik.js";
import { createSkillBridgeHandler } from "./skill/skill-bridge.js";
import { createMemoryBridgeHandler } from "./memory/memory-bridge.js";
import { createInstanceDestroyHandler } from "./routes/instance-destroy.js";
import { createRateLimitHandlers } from "./routes/rate-limits.js";
import { hasAnalyseMarker, hasCostGuardMarker } from "./routes/whitelist.js";
import { tryActivateStorage, tryActivateRedis } from "./injection/index.js";
import { getEffectiveBackend } from "./storage/factory.js";
import type { ProxyConfig } from "./types.js";

export function createApp(config: ProxyConfig): Hono {
  const app = new Hono();

  // Eagerly activate storage/bindingRepo so bridge-only requests (no main
  // /v1/messages hits yet) can still recover session state via L2 fallthrough
  // (memory-bridge.ts / skill-bridge.ts §6.1 fix). Idempotent; the injection
  // pipeline will still call these later when the first main request lands.
  if (!tryActivateStorage(config)) {
    tryActivateRedis(config);
  }

  // `/cost-guard` marker 门控 (P0 前置)：
  // markerOptIn=false 时 marker 完全作废——任何路径里带 `/cost-guard/` 段的请求
  // 都直接 404，避免 catch-all `POST /*` 把它兜住走成默认路由（会产生迷惑：
  // 客户端以为自己"启用了 marker"，proxy 却按 default_passthrough 处理）。
  // 放在最前面，早于所有业务路由。
  if (!config.costGuard.markerOptIn) {
    app.use("*", async (c, next) => {
      if (hasCostGuardMarker(c.req.path)) {
        return c.json(
          {
            error: "cost_guard_marker_disabled",
            message:
              "The /cost-guard URL marker is disabled on this deployment. " +
              "Remove the /cost-guard segment from the path, or set costGuard.markerOptIn=true.",
          },
          404,
        );
      }
      await next();
    });
  }

  // `/analyse` marker 门控（结构完全对齐 cost-guard）：
  // assetReflection.markerOptIn=false 时任何带 `/analyse/` 段的请求都 404，
  // 避免 catch-all 静默兜住把 marker 请求当默认路径处理。此前只有 primary
  // 路由的注册开关，缺这个顶部拒绝——CC/CB 侧的 `/analyse` marker 请求
  // 在 markerOptIn=false 时会 fall through 到 catch-all `POST /*` 让上游
  // 收到裸 body（marker 客户端以为"启用"了实际没走 injector）；codex 侧
  // 同样症状（P1-6 报告里除 `/cost-guard` 之外的 `/analyse` 变体）。一并
  // 修掉，保持两 marker 门控行为对称。
  if (!config.injection?.assetReflection?.markerOptIn) {
    app.use("*", async (c, next) => {
      if (hasAnalyseMarker(c.req.path)) {
        return c.json(
          {
            error: "analyse_marker_disabled",
            message:
              "The /analyse URL marker is disabled on this deployment. " +
              "Remove the /analyse segment from the path, or set " +
              "injection.assetReflection.markerOptIn=true.",
          },
          404,
        );
      }
      await next();
    });
  }

  // Health check
  //
  // 多节点场景：storage 请求 cos 但降级到进程内 (fs / memory / sqlite) 时
  // 返回 503 + degraded=true，让 k8s LB 把该 pod 摘掉，避免"两个节点各写各
  // 的内存"这种数据一致性事故。sqlite 也算 process-local——多节点各自本地
  // 文件也是不共享的。见 docs/design/2026-07-13-proxy-multinode-state-audit.md P0-2。
  app.get("/health", (c) => {
    const eff = getEffectiveBackend();
    const wantsShared = config.storage?.enabled && eff.requested === "cos";
    const degraded = wantsShared && eff.effective !== eff.requested;
    const body = {
      status: degraded ? "degraded" : "ok",
      version: "0.2.0",
      upstream: config.upstream.url,
      opik: config.opik.enabled ? config.opik.url : "disabled",
      costGuard: config.costGuard.enabled ? "enabled" : "disabled",
      rateLimit: config.rateLimit.tpm > 0 || config.rateLimit.qpm > 0 ? "enabled" : "disabled",
      storage: {
        enabled: !!config.storage?.enabled,
        requested: eff.requested,
        effective: eff.effective,
        degraded,
        ...(eff.error ? { lastError: eff.error } : {}),
      },
    };
    return c.json(body, degraded ? 503 : 200);
  });

  // Whoami: resolve API key → key ID (plain text, easy to use with curl)
  app.get("/whoami", (c) => {
    // Support: Authorization header (Bearer), x-api-key header, or ?key= query param
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
    const bearerToken = extractBearerToken(authHeader);
    const xApiKey = c.req.header("x-api-key") ?? "";
    const queryKey = c.req.query("key") ?? "";

    const apiKey = bearerToken || xApiKey || queryKey;

    if (!apiKey) {
      return c.text("Error: No API key provided. Use ?key=YOUR_KEY\n", 400);
    }

    const keyId = apiKeyToKeyId(apiKey);
    return c.text(keyId + "\n");
  });

// Skill bridge: LLM curls land here, proxy injects auth + identity, forwards to core.
  // MUST be registered before the agent-prefixed `/:agent/v1/*` routes below.
  const bridgeHandler = createSkillBridgeHandler(config);
  app.post("/skill-bridge/*", (c) => bridgeHandler(c));

  // Memory bridge: 同样模式但反代 tdai L0/L1/L2/L3 只读接口。
  // 让 LLM 用 Bash 调 <proxy>/memory-bridge/v3/atomic/search 等，proxy 注入身份。
  const memoryBridgeHandler = createMemoryBridgeHandler(config);
  app.post("/memory-bridge/*", (c) => memoryBridgeHandler(c));

  // ── Ops endpoint（在 catch-all `POST /*` 之前注册） ───────────────────────
  // /v3/instance/proxy-destroy — shark 销毁实例时清理 proxy 侧 COS 缓存 +
  // kernel-sts pool。契约字段跟 core `/v3/instance/destroy` 对齐，路径用
  // `proxy-destroy` 动作与 core 区分。鉴权走 config.admin.apiKey（空则公开）。
  const instanceDestroyHandler = createInstanceDestroyHandler(config);
  app.post("/v3/instance/proxy-destroy", (c) => instanceDestroyHandler(c));

  const rateLimitHandlers = createRateLimitHandlers(config);
  app.get("/v3/admin/rate-limits", rateLimitHandlers.get);
  app.put("/v3/admin/rate-limits", rateLimitHandlers.put);
  app.delete("/v3/admin/rate-limits", rateLimitHandlers.delete);

  // ── Session management endpoints (mem: command 底层接口, 面板前端可复用) ──
  app.post("/v3/session/refresh-cache", (c) => {
    return import("./routes/session-refresh.js").then(({ createSessionRefreshHandler }) =>
      createSessionRefreshHandler(config)(c),
    );
  });
  app.post("/v3/session/force-archive-skill", (c) => {
    return import("./routes/session-force-archive.js").then(({ createSessionForceArchiveHandler }) =>
      createSessionForceArchiveHandler(config)(c),
    );
  });

  // ── Whitelisted primary endpoints ────────────────────────────────────────
  // Anthropic Messages API
  app.post("/v1/messages", (c) => handleAnthropicMessages(c, config));

  // ── Whitelisted auxiliary endpoints (must precede catch-all) ─────────────
  // 这些端点走轻量透传 handler（不进入路由模块，不构成对话回合）。
  // 详见 docs/design/2026-07-02-arbitrary-path-passthrough-design.md
  app.post("/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));

  // Agent-prefixed routes with spaceId — 客户端标准配置格式：
  //   CC:  ANTHROPIC_BASE_URL=http://<proxy>:8096/claude-code/<spaceId>
  //   CB:  OPENAI_BASE_URL=http://<proxy>:8096/codebuddy/<spaceId>
  // 路径示例: /claude-code/mem-example001/v1/messages
  //          /codebuddy/mem-example001/v1/chat/completions
  // `/cost-guard` marker: primary handler 检测到该段后启用 cost-guard 路由；
  // 默认路径（不带 marker）则跳过 router 直接透传上游。
  //
  // marker 机制受 `config.costGuard.markerOptIn` 门控：
  //   - false（默认/线上）: 不注册这两条路由——所有请求走 `/:agent/:spaceId/v1/...`，
  //     handler 内 useGuard 恒 true，行为等同于历史"默认走 router"。此时任何
  //     `/cost-guard/...` 请求都命中不到路由，走到最终 catch-all 或返 404
  //     （catch-all `/*` 存在，会 fallthrough 到 handleChatCompletions；下面在
  //     顶部加了 marker→404 拒绝，见 handler / anthropicHandler）。
  //   - true（测试环境）: 注册以下两条 marker 路由；handler 内根据 marker 决定
  //     是否走 router。
  // 详见 `hasCostGuardMarker`。
  // Hono 优先匹配更精确的路径，需注册在通用 `/:agent/:spaceId/v1/...` 之前。
  if (config.costGuard.markerOptIn) {
    app.post("/:agent/:spaceId/cost-guard/v1/messages", (c) => handleAnthropicMessages(c, config));
    app.post("/:agent/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // `/analyse` marker (asset-reflection 内部效果评估) —— 跟 cost-guard 完全对称：
  // 由 `injection.assetReflection.markerOptIn` 门控。marker 只是一个透明标记，
  // handler 内 (AssetReflectionInjector) 检测到即在 system prompt 末尾追加
  // <asset_reflection>；不带 marker 的请求走原有正常路由。
  //
  // ⚠️ 关键：不注册这两条路由时，`/{agent}/{spaceId}/analyse/v1/messages`
  // (5 段) 会 fall through 到最下面的 catch-all `POST /*` → handleChatCompletions
  // (OpenAI handler)，把 Anthropic body 打到 OpenAI 端点 → 上游 400。所以只要
  // markerOptIn=true 就必须显式注册这两条 anthropic/openai 5 段路由。
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/:agent/:spaceId/analyse/v1/messages", (c) => handleAnthropicMessages(c, config));
    app.post("/:agent/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // ── Codex endpoints (must precede generic /:agent/:spaceId routes) ────────
  // Codex CLI 客户端走 OpenAI Responses API，第三条独立协议路径。
  //
  // 客户端行为差异：codex-rs core/src/client.rs 里 endpoint 常量是 `/responses`
  // （不带 /v1），而 CC/CB 客户端的常量是 `/v1/messages` `/v1/chat/completions`
  // （带 /v1）。用户 base_url 惯例：
  //   - CC/CB：base 不带 /v1，客户端自动拼 /v1/messages 等
  //   - Codex：base 需要自带 /v1，客户端拼 /responses
  //
  // 为了让三个 agent 的接入方式对用户统一（base 都填 `/<agent>/<spaceId>`
  // 不带 /v1），proxy 同时接受**带 v1** 和**不带 v1** 两种 path：
  //   /codex/<spaceId>/v1/responses  ← codex 客户端 base 自带 v1 时命中
  //   /codex/<spaceId>/responses     ← codex 客户端 base 不带 v1 时命中（对齐 CC/CB 用法）
  // 两条路径全部映射到 handleCodexEndpoint，行为完全一致。
  app.post("/codex/:spaceId/v1/responses/compact", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/memories/trace_summarize", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/realtime/calls", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/responses", (c) => handleCodexEndpoint(c, config));
  // 兼容 base_url 不带 /v1 的写法（对齐 CC/CB 的用户体验）
  app.post("/codex/:spaceId/responses/compact", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/memories/trace_summarize", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/realtime/calls", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/responses", (c) => handleCodexEndpoint(c, config));

  // ── Workbuddy endpoints (must precede generic /:agent/:spaceId routes) ────
  // WorkBuddy CLI/Desktop 客户端走 OpenAI Responses API（与 Codex 同协议），
  // 但客户端行为与 codex-cli 有差异（sub-path 更多：compact / trace_summarize
  // / realtime / memories属于 aux；主 endpoint 是 /v1/responses）。
  //
  // 与 CC/CB/Codex 一样支持 base_url 带/不带 /v1 两种写法。
  app.post("/workbuddy/:spaceId/v1/responses/compact", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/memories/trace_summarize", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/realtime/calls", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/responses", (c) => handleWorkbuddyEndpoint(c, config));
  // 兼容 base_url 不带 /v1 的写法
  app.post("/workbuddy/:spaceId/responses/compact", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/memories/trace_summarize", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/realtime/calls", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/responses", (c) => handleWorkbuddyEndpoint(c, config));

  // Codex 侧的 `/cost-guard` / `/analyse` marker 路由 —— 完全对齐 CC/CB：
  // marker 是 URL 上的独立段（位于 `/{agent}/{spaceId}` 之后），门控开关相同。
  // 不注册这些路由时，`/codex/{spaceId}/cost-guard/responses` 5 段路径既不
  // 匹配 codex 上面 8 条精确路由，也不匹配任何 agent-prefixed 路由，会 fall
  // through 到 catch-all `POST /*` → handleChatCompletions，把 Responses API
  // body 打到 OpenAI /chat/completions 上游返 200 chatcmpl-* 让客户端崩。
  //
  // `/cost-guard` 语义：primary handler 检测到该段后启用 cost-guard 路由；
  //   codex 侧的 handler 需要在 forwardToUpstream 时读 hasCostGuardMarker
  //   决定是否走 router。（当前 codexHandler.ts 尚未接 resolveForwardTarget，
  //   见 P1-6 报告；本 commit 只解决路由注册与 fall-through 静默 200 的
  //   问题，让请求先到达 codexHandler。cost-guard router 分流的实际支持
  //   独立 commit 处理。）
  //
  // `/analyse` 语义：AssetReflectionInjector 检测到该段后往 system prompt
  //   末尾追加 `<asset_reflection>` 反思块；codexHandler.ts 已将 requestPath
  //   传给注入 pipeline（见 codexHandler.ts injection 段落中 `requestPath:
  //   c.req.path`），路由一注册 `/analyse` marker 立即对 codex 生效。
  if (config.costGuard.markerOptIn) {
    app.post("/codex/:spaceId/cost-guard/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/cost-guard/responses", (c) => handleCodexEndpoint(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/codex/:spaceId/analyse/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/analyse/responses", (c) => handleCodexEndpoint(c, config));
  }

  // ── deepseek-harness (dsh) endpoints ──────────────────────────────────────
  // dsh 是 DeepSeek 官方 agent harness,协议 = 标准 OpenAI Chat Completions
  // (POST /chat/completions + SSE),body/messages shape 100% 兼容 CB 现有 handler。
  //
  // 客户端行为差异(抓包 fixtures/*.req.json 实证,
  // 见 docs/dsh-recon/2026-08-14-dsh-capture-analysis.md):
  //   - dsh 源码 endpoint 常量: `${baseURL}/chat/completions`(**不带 /v1**,
  //     见 packages/llm/llm-deepseek/src/adapter.ts:301)
  //   - 建议用户配置: OPENAI_BASE_URL=http://<proxy>:8096/dsh/<spaceId>
  //   - 与 CC/CB/Codex/Workbuddy 惯例对齐,同时接受**带 v1** 和**不带 v1**两种路径,
  //     用户可选把 baseURL 配成 `.../dsh/<spaceId>` 或 `.../dsh/<spaceId>/v1`
  //
  // main / title / compaction 三类请求识别不在路由层做,由 agent-adapters/dsh.ts
  // 的 classifyRequest 按 header + body 特征判(见其 doc)。
  app.post("/dsh/:spaceId/v1/chat/completions", (c) => handleChatCompletions(c, config));
  app.post("/dsh/:spaceId/chat/completions", (c) => handleChatCompletions(c, config));
  // dsh 目前抓包未见 embeddings/moderations/completions,预留 aux 端点(与 CC/CB 对称)
  app.post("/dsh/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/dsh/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/dsh/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));

  // dsh cost-guard / analyse marker 路由 —— 与 CC/CB/Codex 完全对称。
  // 参照 codex 注释:必须显式注册这四条 5 段路径,否则会 fall through 到 catch-all
  // POST /*(默认路径),marker 静默失效。
  if (config.costGuard.markerOptIn) {
    app.post("/dsh/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/cost-guard/chat/completions", (c) => handleChatCompletions(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/dsh/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/analyse/chat/completions", (c) => handleChatCompletions(c, config));
  }

  app.post("/:agent/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/:agent/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/chat/completions", (c) => handleChatCompletions(c, config));

  // Agent-prefixed routes without spaceId (deprecated: no credit reporting)
  app.post("/:agent/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/:agent/v1/chat/completions", (c) => handleChatCompletions(c, config));

  // Legacy /proxy/<spaceId>/ prefix — no agent info, defaults to codebuddy.
  // 保留以兼容不带 agent 前缀的客户端。
  app.post("/proxy/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/proxy/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/*", (c) => handleChatCompletions(c, config));

  // OpenAI-compatible chat completions (catch-all for any remaining POST paths)
  app.post("/*", (c) => handleChatCompletions(c, config));

  return app;
}
