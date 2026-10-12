/**
 * api/meta-instances.ts — 登录前选实例（GET /api/v1/meta/instances）。
 */
import { request, dedupeInFlight } from './base';

/**
 * 客户端可见的实例元信息。
 *   - `api_key`（真 secret）不下发。
 *   - `gateway_endpoint` 是后端 → 内核的转发地址，也是"客户端接入 baseUrl"。
 *     不属于 secret；每个实例独立，前端不能硬编码。
 *   - `proxy_endpoint` 可选。本地部署时 core 和 proxy 分开，客户端要接的是
 *     proxy，需要显式配置这个字段。仅前端 UI "客户端接入地址" 卡片使用；后端
 *     转发始终走 `gateway_endpoint`，不受它影响。
 */
export interface MetadataInstance {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  proxy_endpoint?: string;
}

/** 面板级能力开关（随实例列表顺带下发，用于菜单/路由可见性控制）。 */
export interface PanelCapabilities {
  /** 「可观测」入口是否开放（面板 env PANEL_FEATURE_ANALYTICS_ENABLED，默认关）。 */
  analyticsEnabled: boolean;
}

/** 老版本 Panel 未下发 capabilities 时的兜底值（保守：不展示入口）。 */
const DEFAULT_CAPABILITIES: PanelCapabilities = { analyticsEnabled: false };

export const metaInstancesApi = {
  /** 登录前选实例；GET /api/v1/meta/instances，公开、无需鉴权、无分页 */
  list: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ instances: MetadataInstance[] }>('GET', '/api/v1/meta/instances').then((r) => r.instances),
    ),

  /**
   * 面板能力开关。与 list() 同一去重 key：并发时共享同一次网络请求，
   * 各自从响应中提取所需字段（list 取 instances、本函数取 capabilities）。
   * 老版本 Panel 响应中没有该字段 → 按关闭兜底。
   */
  capabilities: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ capabilities?: PanelCapabilities }>('GET', '/api/v1/meta/instances').then(
        (r) => r.capabilities ?? DEFAULT_CAPABILITIES,
      ),
    ),
};
