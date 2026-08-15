/**
 * Pure predicate: should the knowledge-tools injector be registered?
 *
 * Exposed as a standalone module so unit tests can import it without pulling
 * in the whole injection pipeline bundle (which binds network ports).
 *
 * Conditions (all must hold):
 *   1. `injection.injectors` includes "knowledge"
 *   2. `knowledge.enabled` is true
 *   3. `knowledge.serviceToken` is non-empty
 */
import type { ProxyConfig } from "../types.js";

export function shouldRegisterKnowledgeInjector(config: ProxyConfig): boolean {
  return config.injection.injectors.includes("knowledge")
    && config.knowledge.enabled
    && !!config.knowledge.serviceToken;
}
