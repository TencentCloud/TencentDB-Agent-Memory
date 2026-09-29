/**
 * Knowledge Panel 路由聚合注册。
 *
 * 挂载：
 *   - /api/v1/knowledge/wiki/*        （wiki-routes）
 *   - /api/v1/knowledge/code-graph/*  （code-graph-routes）
 *   - /api/v1/knowledge/status-callback（callback-routes，S2S）
 *   - /api/v1/knowledge/allocate 等    （allocate-routes）
 *   - /api/v1/knowledge/{type}/team-assets （list-routes）
 */
import type { Hono } from 'hono';
import { registerGitCredentialRoutes } from './git-credential-routes.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { registerKnowledgeWikiRoutes } from './wiki-routes.js';
import { registerKnowledgeCodeGraphRoutes } from './code-graph-routes.js';
import { registerKnowledgeCallbackRoutes } from './callback-routes.js';
import { registerKnowledgeAllocateRoutes } from './allocate-routes.js';
import { registerKnowledgeListRoutes } from './list-routes.js';

export function registerKnowledgeRoutes(api: Hono, deps: PanelDeps): void {
  registerGitCredentialRoutes(api, deps);
  registerKnowledgeWikiRoutes(api, deps);
  registerKnowledgeCodeGraphRoutes(api, deps);
  registerKnowledgeCallbackRoutes(api, deps);
  registerKnowledgeAllocateRoutes(api, deps);
  registerKnowledgeListRoutes(api, deps);
}
