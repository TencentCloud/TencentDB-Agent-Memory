/**
 * Thin read-only ClickHouse client for analytics queries.
 *
 * Separate from the write-only ClickHouseDirectExporter (OTel export).
 * No buffering/batching — reads are synchronous request-response.
 *
 * @clickhouse/client is an optional dependency; if not installed,
 * createAnalyticsChClient() returns null with a warning.
 */

import type { ClickHouseConfig } from "../config.js";

type Logger = { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

export interface AnalyticsChClient {
  query<T = Record<string, unknown>>(params: {
    query: string;
    query_params?: Record<string, unknown>;
  }): Promise<T[]>;
  ping(): Promise<boolean>;
  checkTables(names: string[]): Promise<Record<string, boolean>>;
  close(): Promise<void>;
}

export function createAnalyticsChClient(
  config: ClickHouseConfig | undefined,
  logger: Logger,
): AnalyticsChClient | null {
  if (!config?.enabled || !config.endpoint) {
    return null;
  }

  // Return a promise-based factory so the caller can await initialization.
  // For sync callers, use createAnalyticsChClientSync (below).
  return null; // placeholder — use async factory below
}

/**
 * Async factory that dynamically imports @clickhouse/client (works with vi.mock in ESM tests).
 */
export async function createAnalyticsChClientAsync(
  config: ClickHouseConfig | undefined,
  logger: Logger,
): Promise<AnalyticsChClient | null> {
  if (!config?.enabled || !config.endpoint) return null;

  const TAG = "[analytics-ch]";
  let chModule: typeof import("@clickhouse/client");
  try {
    chModule = await import("@clickhouse/client");
  } catch (err) {
    logger.warn?.(TAG, "@clickhouse/client not available:", (err as Error).message);
    return null;
  }

  const client = chModule.createClient({
    url: config.endpoint,
    username: config.username,
    password: config.password,
    database: config.database,
    request_timeout: 30_000,
  });

  return {
    async query<T = Record<string, unknown>>(params: {
      query: string;
      query_params?: Record<string, unknown>;
    }): Promise<T[]> {
      const result = await client.query({
        query: params.query,
        query_params: params.query_params,
        format: "JSONEachRow",
      });
      return await result.json() as T[];
    },

    async ping(): Promise<boolean> {
      try {
        const result = await client.ping();
        return result.success;
      } catch (err) {
        logger.warn?.(TAG, "ping failed:", (err as Error).message);
        return false;
      }
    },

    async checkTables(names: string[]): Promise<Record<string, boolean>> {
      const result: Record<string, boolean> = {};
      for (const name of names) {
        try {
          const res = await client.query({
            query: `EXISTS TABLE ${name}`,
            format: "JSONEachRow",
          });
          const rows = await res.json() as Array<{ result: number }>;
          result[name] = rows.length > 0 && rows[0].result === 1;
        } catch {
          result[name] = false;
        }
      }
      return result;
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}
