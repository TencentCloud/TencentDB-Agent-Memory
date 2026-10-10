/**
 * 将 Gateway yaml `taskSource` 段回填到 process.env（**仅当 env 未设置时**）。
 *
 * 解析优先级：process.env > yaml —— 与 metadata-env.ts / config.ts 全局约定一致。
 * task-source 的 registry / provider 仍只读 env，无需改调用签名。
 *
 * 为什么走「回填 env」而不是「把 config 传进 registry」：
 *   provider 的 env 名由 `TASK_SOURCE_<ID>_<后缀>` 动态拼成，后缀由 provider
 *   自己声明，通用层不预设。传结构化 config 下去等于把「env 名拼接规则」复制
 *   一份到 registry，两处规则容易漂移；回填 env 让 registry 保持唯一规则。
 *
 * yaml 用驼峰（与 metadata / skill 等段一致），这里负责驼峰 → env 名的转换：
 *
 *   taskSource:
 *     enabled: tapd                      → TASK_SOURCE_ENABLED
 *     taiPatUrl: https://…               → TAI_PAT_URL
 *     sources:
 *       tapd:
 *         mcpUrl: https://…              → TASK_SOURCE_TAPD_MCP_URL
 *         siteBaseUrl: https://…         → TASK_SOURCE_TAPD_SITE_BASE_URL
 */

import type { GatewayTaskSourceConfig } from "./config.js";

function setEnvIfEmpty(key: string, value: string | undefined): void {
  if (value && !process.env[key]?.trim()) {
    process.env[key] = value;
  }
}

/** 驼峰键 → env 后缀。`mcpUrl` → `MCP_URL`；`siteBaseUrl` → `SITE_BASE_URL`。 */
function toEnvSuffix(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
}

/**
 * 在 TdaiGateway.start() 早期（任何 task-source 路由 / provider 调用之前）调用。
 *
 * 未配置 `taskSource` 时是 no-op —— 纯 env 部署不受影响。
 */
export function applyTaskSourceEnvFromGatewayConfig(taskSource: GatewayTaskSourceConfig): void {
  setEnvIfEmpty("TASK_SOURCE_ENABLED", taskSource.enabled);
  setEnvIfEmpty("TAI_PAT_URL", taskSource.taiPatUrl);

  const sources = taskSource.sources;
  if (!sources) return;
  for (const [sourceId, entries] of Object.entries(sources)) {
    const upper = sourceId.toUpperCase();
    for (const [key, value] of Object.entries(entries)) {
      setEnvIfEmpty(`TASK_SOURCE_${upper}_${toEnvSuffix(key)}`, value);
    }
  }
}
