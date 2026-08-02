/**
 * Type augmentation for `@ai-sdk/openai` used by the gateway typecheck.
 *
 * The installed ai-sdk release dropped the `compatibility` option from
 * `OpenAIProviderSettings`, while `src/adapters/standalone/llm-runner.ts`
 * still passes it to `createOpenAI()`. Augmenting the interface restores
 * type compatibility for that committed call site without changing runtime
 * behavior (extra properties are ignored by the provider).
 *
 * Module-style (top-level import) so `declare module` merges into the real
 * interface instead of shadowing it.
 */
import type {} from "@ai-sdk/openai";

declare module "@ai-sdk/openai" {
  interface OpenAIProviderSettings {
    /**
     * Provider compatibility mode ("strict" | "compatible" | "auto").
     * Accepted for backwards compatibility with older ai-sdk releases;
     * ignored by the installed version at runtime.
     */
    compatibility?: string;
  }
}
