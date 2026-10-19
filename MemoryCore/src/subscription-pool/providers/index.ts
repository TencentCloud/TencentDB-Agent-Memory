import type { SubscriptionProvider } from "../../metadata/types.js";
import { createClaudeAdapter } from "./claude.js";
import { createCodexAdapter } from "./codex.js";
import type { SubscriptionProviderAdapter } from "./types.js";

/** Providers that can join a pool. Each one has an adapter that owns its login and usage calls. */
export const SUPPORTED_SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = ["claude", "codex"];

const adapters: Record<SubscriptionProvider, SubscriptionProviderAdapter> = {
  claude: createClaudeAdapter(),
  codex: createCodexAdapter(),
};

/** Adapter of a supported provider, or null. */
export function subscriptionAdapterFor(provider: SubscriptionProvider): SubscriptionProviderAdapter | null {
  return adapters[provider] ?? null;
}
