import { AsyncLocalStorage } from "node:async_hooks";

interface SkillAssetRequestContext {
  instanceId: string;
}

const skillAssetContext = new AsyncLocalStorage<SkillAssetRequestContext>();

export function runWithSkillAssetInstance<T>(
  instanceId: string,
  callback: () => T,
): T {
  return skillAssetContext.run({ instanceId }, callback);
}

export function getSkillAssetInstance(): string | undefined {
  return skillAssetContext.getStore()?.instanceId;
}

export function resolveSkillAssetInstance(fallback: string): string {
  return getSkillAssetInstance() ?? fallback;
}
