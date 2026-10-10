import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import { checkAdminAuth, adminAuthError } from "./admin-auth.js";

export interface ModelAliasEntry {
  name: string;
  modelName: string;
}

export interface ModelAliasListResponse {
  code: 0;
  data: { items: ModelAliasEntry[] };
}

export function createModelAliasHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    const auth = checkAdminAuth(c, config.admin.apiKey);
    if (auth !== "ok") return adminAuthError(c, auth);

    const items: ModelAliasEntry[] = [];
    for (const m of config.creditPricing.models) {
      if (!m.name) continue;
      items.push({
        name: m.name,
        modelName: m.modelName ?? m.name,
      });
    }

    return c.json({ code: 0, data: { items } } satisfies ModelAliasListResponse);
  };
}
