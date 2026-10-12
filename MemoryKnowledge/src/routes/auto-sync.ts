/**
 * Auto-Sync Admin Routes — 调度器状态查询 + 手动触发。
 *
 * Endpoints:
 *   GET  /auto-sync/status   → 当前调度器状态（running/activeSyncs/scanning）+ 配置
 *   POST /auto-sync/trigger  → 手动触发一轮全量扫描（fire-and-forget，立即返回）
 *
 * 路由挂载时无 prefix，由 server.ts 统一加 /v3。
 */

import { Hono } from "hono";
import type { AutoSyncScheduler, AutoSyncConfig } from "../store/auto-sync-scheduler.js";
import { wrapOk } from "../api-helpers.js";

export interface AutoSyncRouteDeps {
  scheduler: AutoSyncScheduler;
  config: AutoSyncConfig;
}

export function createAutoSyncRoutes(deps: AutoSyncRouteDeps) {
  const app = new Hono();
  const { scheduler, config } = deps;

  // GET /auto-sync/status — 查看调度器运行状态 + 配置
  app.get("/auto-sync/status", (c) => {
    const status = scheduler.getStatus();
    return c.json(wrapOk({
      ...status,
      config: {
        enabled: config.enabled,
        scanIntervalMs: config.scanIntervalMs,
        maxConcurrentSyncs: config.maxConcurrentSyncs,
      },
    }));
  });

  // POST /auto-sync/trigger — 手动触发一轮扫描（fire-and-forget）
  app.post("/auto-sync/trigger", (c) => {
    if (!config.enabled) {
      return c.json(wrapOk({ triggered: false, reason: "auto-sync is disabled by KNOWLEDGE_AUTO_SYNC_ENABLED" }));
    }
    scheduler.triggerScan();
    return c.json(wrapOk({ triggered: true }));
  });

  return app;
}
