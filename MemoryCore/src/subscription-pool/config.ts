export interface SubscriptionPoolConfig {
  enabled: boolean;
  checkIntervalMin: number;
}

export function readSubscriptionPoolConfig(env: NodeJS.ProcessEnv = process.env): SubscriptionPoolConfig {
  const enabled = env.SUBSCRIPTION_POOL_ENABLED !== "false";
  const parsed = Number(env.SUBSCRIPTION_POOL_CHECK_INTERVAL_MIN ?? 30);
  const checkIntervalMin = Number.isFinite(parsed) && parsed >= 1 ? parsed : 30;
  return { enabled, checkIntervalMin };
}
