import { AsyncLocalStorage } from "node:async_hooks";

const skillInstanceStorage = new AsyncLocalStorage<string>();

/** Run one Skill request with the service instance selected by its auth header. */
export function runWithSkillInstance<T>(instanceId: string, fn: () => T): T {
  return skillInstanceStorage.run(instanceId, fn);
}

/** Resolve the active request instance, preserving the legacy non-HTTP fallback. */
export function resolveSkillInstance(fallbackInstanceId: string): string {
  return skillInstanceStorage.getStore() ?? fallbackInstanceId;
}
