import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';

export function registerHealthRoutes(app: Hono): void {
  app.get('/health', (c) => c.json({ status: 'ok' }));
}

export function registerMetaInstanceRoutes(api: Hono, deps: PanelDeps): void {
  api.get('/meta/instances', (c) => {
    return c.json({
      instances: deps.instanceRegistry.listPublic(),
      // 面板级能力开关随实例列表顺带下发（不新增接口）：
      // 「可观测」入口是否开放由部署方通过 PANEL_FEATURE_ANALYTICS_ENABLED 控制，
      // 默认关闭；开启后前端再结合 /api/v1/analytics/config 的 CH 探测结果
      // 决定菜单/路由是否最终可见。
      capabilities: { analyticsEnabled: deps.config.featureAnalyticsEnabled },
    });
  });
}
