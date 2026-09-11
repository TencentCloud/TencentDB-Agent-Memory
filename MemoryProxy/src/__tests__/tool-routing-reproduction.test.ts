import { readFileSync, existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCases, buildEvalProviderRequest } from "../../scripts/eval/tool-routing/prompts.js";
import { experimentFingerprint } from "../../scripts/eval/tool-routing/experiment.js";
import { providerConfiguration, providerRequestParams } from "../../scripts/eval/tool-routing/provider-config.js";
import { runModel } from "../../scripts/eval/tool-routing/run.js";
const cases = loadCases();
const saved = readFileSync(new URL("../../scripts/eval/tool-routing/results/per-case.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
afterEach(() => vi.unstubAllEnvs());
describe("checked-in tool-routing reproduction", () => {
  it("hydrates 297 self-contained cases and preserves all 594 recorded initial requests", async () => {
    vi.stubEnv("SKILL_VIEW_MODE", "name");
    vi.stubEnv("TOOL_ROUTING_THINKING_MODE", "disabled");
    vi.stubEnv("TOOL_ROUTING_EXTRA_BODY_JSON", '{"thinking":{"type":"disabled"}}');
    const config = providerConfiguration(12, 8192, 90_000);
    expect(cases).toHaveLength(297); expect(new Set(cases.map(c => c.id)).size).toBe(297);
    for (const c of cases) for (const variant of ["baseline", "candidate"] as const) {
      const actual = await buildEvalProviderRequest(variant, c, { requestParams: providerRequestParams("deepseek-v4-flash", config) });
      expect(experimentFingerprint(actual.request), `${c.id}/${variant}`).toBe(saved.find(r => r.case_id === c.id && r.variant === variant).request_sha256);
    }
  });
  it.skipIf(process.platform !== "darwin" || !existsSync("/opt/homebrew/bin/python3.14"))("executes real local reads with a simulated provider", async () => {
    vi.stubEnv("TOOL_ROUTING_API_KEY", "test-only");
    vi.stubEnv("TOOL_ROUTING_API_URL", "https://invalid.test/chat/completions");
    vi.stubEnv("TOOL_ROUTING_MODEL", "deepseek-v4-flash");
    vi.stubEnv("TOOL_ROUTING_PYTHON_EXECUTABLE", "/opt/homebrew/bin/python3.14");
    vi.stubEnv("SKILL_VIEW_MODE", "name");
    vi.stubEnv("TOOL_ROUTING_THINKING_MODE", "disabled");
    vi.stubEnv("TOOL_ROUTING_EXTRA_BODY_JSON", '{"thinking":{"type":"disabled"}}');
    const c = cases.find(c => c.category === "coding-negative")!; let requests = 0;
    const fetcher = async () => new Response(JSON.stringify({ model: "deepseek-v4-flash", usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ finish_reason: "stop", message: requests++ === 0
      ? { role: "assistant", content: null, tool_calls: c.coding_expectation!.read_paths!.map((path, i) => ({ id: `read-${i}`, type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: path }) } })) }
      : { role: "assistant", content: "fixture complete" } }] }), { status: 200 });
    const r = await runModel("candidate", c, 1, { config: providerConfiguration(12, 8192, 90_000), fetcher });
    expect(r.error).toBeUndefined(); expect(r.window_complete).toBe(true); expect(r.coding_progress?.read).toBe(true); expect(requests).toBe(2);
  });
});
