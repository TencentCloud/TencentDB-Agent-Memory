/**
 * source-provider routes —— 已启用的外部来源列表（读部署配置）。
 *
 * Panel 前端据此渲染下拉，不在 Panel 侧重复配置（KS 是唯一真相源）。
 */

import { Hono } from "hono";

import { wrapOk } from "../api-helpers.js";
import { CodeSourceRegistry } from "../code-source/registry.js";
import { WikiSourceRegistry } from "../wiki-source/registry.js";

export interface SourceProviderRouteDeps {
  registry?: CodeSourceRegistry;
  wikiRegistry?: WikiSourceRegistry;
}

export function createSourceProviderRoutes(deps: SourceProviderRouteDeps = {}): Hono {
  const app = new Hono();
  const registry = deps.registry ?? new CodeSourceRegistry();
  const wikiRegistry = deps.wikiRegistry ?? new WikiSourceRegistry();

  // GET /code —— codegraph 来源（gongfeng / github / gitlab ...）
  app.get("/code", (c) => c.json(wrapOk({ items: registry.list() })));

  // GET /wiki —— wiki 来源（iwiki ...）
  app.get("/wiki", (c) => c.json(wrapOk({ items: wikiRegistry.list() })));

  // GET / —— 聚合全部类型
  app.get("/", (c) =>
    c.json(wrapOk({ code: registry.list(), wiki: wikiRegistry.list() })),
  );

  return app;
}
