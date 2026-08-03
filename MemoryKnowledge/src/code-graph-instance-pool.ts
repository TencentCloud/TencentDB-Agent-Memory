import type { CodeGraphInstance } from "./engines/code/index.js";

export interface CodeGraphInstancePool {
  get(codeGraphId: string): CodeGraphInstance | undefined;
  set(codeGraphId: string, instance: CodeGraphInstance): void;
  delete(codeGraphId: string): void;
  loadIfMissing?(
    codeGraphId: string,
    dir: string,
  ): Promise<CodeGraphInstance | undefined>;
}

export interface CodeGraphInstancePoolOptions {
  loadIndex: (dir: string) => Promise<CodeGraphInstance>;
  closeIndex: (instance: CodeGraphInstance) => void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

interface PendingLoad {
  token: { invalidated: boolean };
  promise: Promise<CodeGraphInstance | undefined>;
}

export function createCodeGraphInstancePool(
  options: CodeGraphInstancePoolOptions,
): CodeGraphInstancePool & {
  loadIfMissing(
    codeGraphId: string,
    dir: string,
  ): Promise<CodeGraphInstance | undefined>;
} {
  const instances = new Map<string, CodeGraphInstance>();
  const pendingLoads = new Map<string, PendingLoad>();

  const invalidatePending = (codeGraphId: string): void => {
    const pending = pendingLoads.get(codeGraphId);
    if (!pending) return;
    pending.token.invalidated = true;
    pendingLoads.delete(codeGraphId);
  };

  return {
    get(codeGraphId) {
      return instances.get(codeGraphId);
    },

    set(codeGraphId, instance) {
      invalidatePending(codeGraphId);
      instances.set(codeGraphId, instance);
    },

    delete(codeGraphId) {
      invalidatePending(codeGraphId);
      instances.delete(codeGraphId);
    },

    loadIfMissing(codeGraphId, dir) {
      const cached = instances.get(codeGraphId);
      if (cached) return Promise.resolve(cached);

      const existing = pendingLoads.get(codeGraphId);
      if (existing) return existing.promise;

      const token = { invalidated: false };
      const promise: Promise<CodeGraphInstance | undefined> = Promise.resolve()
        .then(() => options.loadIndex(dir))
        .then((instance) => {
          if (token.invalidated) {
            try {
              options.closeIndex(instance);
            } catch (err) {
              options.logger?.warn?.(
                `[code-graph] close invalidated lazy-load failed ${codeGraphId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
            return instances.get(codeGraphId);
          }
          instances.set(codeGraphId, instance);
          options.logger?.info?.(
            `[code-graph] lazy-loaded instance ${codeGraphId}`,
          );
          return instance;
        })
        .catch((err: unknown) => {
          options.logger?.warn?.(
            `[code-graph] lazy-load failed ${codeGraphId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return undefined;
        })
        .finally(() => {
          const current = pendingLoads.get(codeGraphId);
          if (current?.token === token) {
            pendingLoads.delete(codeGraphId);
          }
        });

      pendingLoads.set(codeGraphId, { token, promise });
      return promise;
    },
  };
}
