import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerLocalE2EProvider(pi: ExtensionAPI): void {
  pi.registerProvider("tdai-e2e", {
    name: "TencentDB Memory E2E Local",
    baseUrl: process.env.TDAI_PI_E2E_OPENAI_BASE_URL ?? "http://127.0.0.1:18080/v1",
    apiKey: "$TDAI_PI_E2E_OPENAI_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "tdai-e2e-model",
        name: "TencentDB Memory E2E Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
