import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const instanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  gateway_endpoint: z.string().url(),
  // 可选：客户端接入地址（如 CodeBuddy / ClaudeCode CLI 的 baseUrl）。
  // 与 `gateway_endpoint` 的区别：
  //   - `gateway_endpoint` 一定是 Panel 后端 → Kernel 的转发地址（core / gateway）,
  //     线上是 gateway，本地开源部署可直接指 core；这个字段控制 **面板转发**，绝对不能挪。
  //   - `proxy_endpoint` 仅供前端"客户端接入地址"卡片拼接展示。
  //     线上部署时 gateway 前置了 proxy，两个值合一（缺省即可，回落到 gateway_endpoint 保持老行为）；
  //     开源本地部署时 core 和 proxy 分开跑，客户端要接的是 proxy，才需要显式填这个字段。
  proxy_endpoint: z.string().url().optional(),
  api_key: z.string().min(1),
});

const fileSchema = z.object({
  instances: z.array(instanceSchema).min(1),
});

export interface InstanceEntry {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  /** 见 instanceSchema.proxy_endpoint 上方注释；未配置则前端回落 gateway_endpoint。 */
  proxy_endpoint?: string;
  api_key: string;
}

export interface PublicInstance {
  instance_id: string;
  name: string;
  /**
   * Panel 后端 → Kernel 的转发地址（如 https://memory.ap-beijing.tencenttdai.com）。
   * 不是 secret —— CodeBuddy / ClaudeCode CLI 用户历史上也拿它去配 baseUrl；
   * 前端不能硬编码，每个实例的 endpoint 都不同（dev/staging/prod）。
   * `api_key` 是 secret，不下发。
   */
  gateway_endpoint: string;
  /**
   * 可选：客户端接入 baseUrl（前端"客户端接入地址"卡片显示时用）。
   * 缺省时前端回落到 `gateway_endpoint`，等同老行为。**Panel 转发链路不使用**。
   */
  proxy_endpoint?: string;
}

export class InstanceRegistryError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'InstanceRegistryError';
  }
}

export class InstanceRegistry {
  private readonly byId: Map<string, InstanceEntry>;

  constructor(entries: InstanceEntry[]) {
    this.byId = new Map(entries.map((e) => [e.instance_id, e]));
  }

  static load(configPath: string): InstanceRegistry {
    const filePath = resolve(configPath);
    if (!existsSync(filePath)) {
      throw new InstanceRegistryError(
        500,
        `metadata instances config not found: ${filePath}\n` +
          `  hint: cp config/metadata-instances.example.json config/metadata-instances.json`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    } catch {
      throw new InstanceRegistryError(500, `invalid metadata instances config: ${filePath}`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InstanceRegistryError(500, `metadata instances config validation failed`);
    }
    const entries = parsed.data.instances.map((row) => ({
      instance_id: row.id,
      name: row.name,
      gateway_endpoint: row.gateway_endpoint,
      proxy_endpoint: row.proxy_endpoint,
      api_key: row.api_key,
    }));
    return new InstanceRegistry(entries);
  }

  resolve(instanceId: string): InstanceEntry {
    const entry = this.byId.get(instanceId);
    if (!entry) {
      throw new InstanceRegistryError(400, 'INVALID_INSTANCE');
    }
    return entry;
  }

  listPublic(): PublicInstance[] {
    return [...this.byId.values()].map(({ instance_id, name, gateway_endpoint, proxy_endpoint }) => ({
      instance_id,
      name,
      gateway_endpoint,
      // 不填就不下发字段（不是显式 undefined，前端 `??` 回落更干净）
      ...(proxy_endpoint ? { proxy_endpoint } : {}),
    }));
  }

  /** Full entries incl. credentials — internal startup/admin use only, never client-facing. */
  listAll(): InstanceEntry[] {
    return [...this.byId.values()];
  }
}
