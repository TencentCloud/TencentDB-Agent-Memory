import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { requestLogger } from './middleware/request-logger.js';
import { apiCallTelemetryMiddleware } from './middleware/api-call-telemetry-middleware.js';
import type { PanelDeps } from '../panel-deps.js';
import { registerHealthRoutes, registerMetaInstanceRoutes } from './routes/meta/instances.js';
import { registerMetaProxyRoutes } from './routes/meta/proxy.js';
import { registerSkillProxyRoutes } from './routes/skill/proxy.js';
import { registerAnalyticsProxyRoutes } from './routes/analytics/proxy.js';
import { registerChatMemoryRoutes } from './routes/chat-memory.js';
import { registerTaskRoutes } from './routes/task.js';
import { registerAgentOverviewRoutes } from './routes/agent-overview.js';
import { registerAgentLifecycleRoutes } from './routes/agent-lifecycle.js';
import { registerKnowledgeRoutes } from './routes/knowledge/index.js';
import { registerAuthRoutes, registerWoaIngressRoutes } from './routes/auth.js';

import { registerUpstreamTestRoute } from './routes/upstream-test.js';

const API_PREFIX = '/api/v1';

export function buildPanelApp(deps: PanelDeps): Hono {
  const app = new Hono();

  app.use('*', requestLogger(deps.logger));

  registerHealthRoutes(app);

  const api = new Hono();
  // API 调用审计（可选 ClickHouse 上报，不配则 NoOp）
  // user_id 采集三级兜底: route.set('resolvedUserId') > userIdResolver cache > 空
  api.use('*', apiCallTelemetryMiddleware(deps.apiCallTelemetry, deps.userIdResolver));
  registerMetaInstanceRoutes(api, deps);
  registerAuthRoutes(api, deps);
  registerUpstreamTestRoute(api, deps);
  registerMetaProxyRoutes(api, deps);
  // Skill 数据面透明代理：/api/v1/skill/* → 内核 /v3/skill/*
  registerSkillProxyRoutes(api, deps);
  // Analytics 查询面透明代理：/api/v1/analytics/* → 内核 /v3/analytics/*
  registerAnalyticsProxyRoutes(api, deps);
  // Chat Memory 面板 3-tab 专属业务路由（12.3 决策例外，见 chat-memory.ts 顶注释）
  registerChatMemoryRoutes(api, deps);
  // Task 聚合路由：task/list + 批量 task-agent/list 一次返回
  registerTaskRoutes(api, deps);
  registerAgentOverviewRoutes(api, deps);
  // Agent 生命周期业务路由：/agent/delete-cascade 在 control 层级联清 skill 再 archive
  registerAgentLifecycleRoutes(api, deps);
  registerKnowledgeRoutes(api, deps);
  app.route(API_PREFIX, api);
  // 仅当至少一个 header-injected Provider 已注册时才挂 ingress 中间件：
  // 该中间件会拦截"根路径 GET + 命中任一 Provider 的 ingressHeaderName"的请求
  // 自动完成 IdP 登录。未启用时不注册，上游网关转发来的带头请求会原样落到静态资源，
  // 避免"未开 IdP 却仍被 IdP 流程绑架"。
  // 双层 optional chaining：既有测试 fixture 只塞被测路由需要的字段，`deps.auth`
  // 与 `deps.config.auth` 常被整块省略；缺任何一层都视为未启用 IdP，与 v1 时代
  // `deps.config.auth?.woa?.enabled` 的兼容语义一致。
  if (deps.auth?.listHeaderInjectedProviders?.().length) {
    registerWoaIngressRoutes(app, deps);
  }

  app.onError((err, c) => {
    deps.logger.error('panel unhandled error', {
      err: err instanceof Error ? err.message : String(err),
      path: c.req.path,
    });
    return c.json(
      { code: 500, message: 'INTERNAL', request_id: c.get('reqId') ?? '', data: null },
      500,
    );
  });

  const distDir = deps.config.ui.distDir;
  app.use('/*', serveStatic({ root: distDir }));
  app.get('*', (c, next) => {
    const p = c.req.path;
    if (p.startsWith('/api/') || p === '/health') return next();
    return serveStatic({ path: path.join(distDir, 'index.html') })(c, next);
  });

  return app;
}
