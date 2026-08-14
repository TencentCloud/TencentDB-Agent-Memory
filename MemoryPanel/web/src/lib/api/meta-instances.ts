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

export const metaInstancesApi = {
  /** 登录前选实例；GET /api/v1/meta/instances，公开、无需鉴权、无分页 */
  list: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ instances: MetadataInstance[] }>('GET', '/api/v1/meta/instances').then((r) => r.instances),
    ),
};
