/**
 * What goes on the wire for asymmetric embedding models.
 *
 * Measured against nvidia/nemotron-3-embed-1b: a corpus embedded with no
 * `input_type` at all collapses towards one hub vector (top-1 recall 3/7 on a
 * mixed ru/en corpus, margins ≈0.00); with the field present the same corpus
 * recalls 7/7. So "is the field there, and does the search side say query"
 * is worth pinning.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddingService,
  type OpenAIEmbeddingConfig,
} from "./embedding.js";

const BASE: OpenAIEmbeddingConfig = {
  provider: "nvidia",
  baseUrl: "https://example.invalid/v1",
  apiKey: "k",
  model: "nvidia/nemotron-3-embed-1b",
  dimensions: 4,
};

/** Capture the request body a single embed() call puts on the wire. */
function captureBody(vectorField: "openai" | "zeroentropy" = "openai") {
  const seen: Array<Record<string, unknown>> = [];
  const payload =
    vectorField === "openai"
      ? { data: [{ index: 0, embedding: [1, 0, 0, 0] }] }
      : { results: [{ embedding: [1, 0, 0, 0] }] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("input_type on the wire", () => {
  it("is absent by default — OpenAI and llama.cpp reject unknown fields", async () => {
    const seen = captureBody();
    await createEmbeddingService(BASE).embed("привет", {
      inputType: "query",
    });
    expect(seen[0]).not.toHaveProperty("input_type");
  });

  it("is sent as passage for stored text once the provider asks for it", async () => {
    const seen = captureBody();
    await createEmbeddingService({ ...BASE, sendInputType: true }).embed(
      "запись памяти",
    );
    expect(seen[0].input_type).toBe("passage");
  });

  it("is sent as query for a search", async () => {
    const seen = captureBody();
    await createEmbeddingService({ ...BASE, sendInputType: true }).embed(
      "какой порт у гейтвея",
      { inputType: "query" },
    );
    expect(seen[0].input_type).toBe("query");
  });

  it("keeps the label on every sub-batch, not just the first", async () => {
    const seen = captureBody();
    const texts = Array.from({ length: 300 }, (_, i) => `текст ${i}`);
    await createEmbeddingService({ ...BASE, sendInputType: true }).embedBatch(
      texts,
      { inputType: "query" },
    );
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((body) => body.input_type === "query")).toBe(true);
  });

  it("speaks ZeroEntropy's word for the stored side", async () => {
    const seen = captureBody("zeroentropy");
    const service = createEmbeddingService({
      ...BASE,
      provider: "zeroentropy",
      model: "zembed-1",
    });
    await service.embed("запись памяти");
    await service.embed("вопрос", { inputType: "query" });
    expect(seen.map((body) => body.input_type)).toEqual(["document", "query"]);
  });
});
