import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { requestLogger } from './middleware/request-logger.js';
import type { PanelDeps } from '../panel-deps.js';
import { registerHealthRoutes, registerMetaInstanceRoutes } from './routes/meta/instances.js';
import { registerMetaProxyRoutes } from './routes/meta/proxy.js';
import { registerSkillProxyRoutes } from './routes/skill/proxy.js';
import { registerChatMemoryRoutes } from './routes/chat-memory.js';
import { registerTaskRoutes } from './routes/task.js';
import { registerAgentOverviewRoutes } from './routes/agent-overview.js';
import { registerAgentLifecycleRoutes } from './routes/agent-lifecycle.js';
import { registerKnowledgeRoutes } from './routes/knowledge/index.js';
import { registerTeamAtlasRoutes } from './routes/team-atlas.js';
import { registerChatMemoryStatusRoutes } from './routes/chat-memory-status.js';

const API_PREFIX = '/api/v1';

export function buildPanelApp(deps: PanelDeps): Hono {
  const app = new Hono();

  app.use('*', requestLogger(deps.logger));

  registerHealthRoutes(app);

  const api = new Hono();
  registerMetaInstanceRoutes(api, deps);
  registerMetaProxyRoutes(api, deps);
  // Skill 数据面透明代理：/api/v1/skill/* → 内核 /v3/skill/*
  registerSkillProxyRoutes(api, deps);
  // Chat Memory 面板 3-tab 专属业务路由（12.3 决策例外，见 chat-memory.ts 顶注释）
  registerChatMemoryRoutes(api, deps);
  // Task 聚合路由：task/list + 批量 task-agent/list 一次返回
  registerTaskRoutes(api, deps);
  registerAgentOverviewRoutes(api, deps);
  // Agent 生命周期业务路由：/agent/delete-cascade 在 control 层级联清 skill 再 archive
  registerAgentLifecycleRoutes(api, deps);
  registerKnowledgeRoutes(api, deps);
  registerTeamAtlasRoutes(api, deps);
  registerChatMemoryStatusRoutes(api, deps);
  app.route(API_PREFIX, api);

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
