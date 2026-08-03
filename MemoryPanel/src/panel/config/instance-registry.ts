import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const instanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  gateway_endpoint: z.string().url(),
  api_key: z.string().min(1),
});

const fileSchema = z.object({
  instances: z.array(instanceSchema).min(1),
});

export interface InstanceEntry {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  api_key: string;
}

export interface PublicInstance {
  instance_id: string;
  name: string;
  /**
   * 客户端接入 gateway 根地址（如 https://memory.ap-beijing.tencenttdai.com）。
   * 不是 secret —— CodeBuddy / ClaudeCode CLI 用户必须拿到才能配 baseUrl；
   * 每个实例的 endpoint 都不同（dev/staging/prod），前端不能硬编码。
   * `api_key` 是 secret，不下发。
   */
  gateway_endpoint: string;
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
    this.byId = new Map();
    for (const entry of entries) {
      if (this.byId.has(entry.instance_id)) {
        throw new InstanceRegistryError(
          500,
          `duplicate metadata instance id: ${entry.instance_id}`,
        );
      }
      this.byId.set(entry.instance_id, entry);
    }
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
    return [...this.byId.values()].map(({ instance_id, name, gateway_endpoint }) => ({
      instance_id,
      name,
      gateway_endpoint,
    }));
  }

  /** Full entries incl. credentials — internal startup/admin use only, never client-facing. */
  listAll(): InstanceEntry[] {
    return [...this.byId.values()];
  }
}
