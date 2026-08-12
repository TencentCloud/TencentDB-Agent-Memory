/**
 * tz-10b — the injected text is a projection of the envelope.
 *
 * The load-bearing claim is byte equality: what `/recall` sends as `context` is
 * `[prependContext, appendSystemContext].join("\n\n")`, and that string must be
 * exactly `envelope.renderedContext`. If the two can drift, the envelope
 * explains a text nobody saw.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performAutoRecall } from "./recall.js";
import { parseConfig } from "../../../config.js";

async function recallIn(dir: string, budgetTokens?: number) {
  return performAutoRecall({
    userText: "",
    actorId: "u",
    sessionKey: "cc-test",
    cfg: parseConfig({
      recall: {
        strategy: "keyword",
        ...(budgetTokens === undefined
          ? {}
          : { contextBudgetTokens: budgetTokens }),
      },
    }),
    pluginDataDir: dir,
  });
}

function sandboxWithPersona(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz10b-"));
  fs.writeFileSync(
    path.join(dir, "persona.md"),
    "Пользователь пишет телеграфно.",
  );
  return dir;
}

describe("recall shell: text projects the envelope", () => {
  it("carries persona as an item with a cost, and renders exactly renderedContext", async () => {
    const dir = sandboxWithPersona();
    try {
      const result = await recallIn(dir);
      const envelope = result!.envelope!;
      const persona = envelope.included.find((i) => i.kind === "persona");
      expect(persona).toBeDefined();
      expect(persona!.memoryId).toMatch(/^persona:[0-9a-f]{8}$/);
      expect(persona!.tokenCost).toBeGreaterThan(0);
      expect(persona!.provenance.status).toBe("unknown");

      const injected = [result!.prependContext, result!.appendSystemContext]
        .filter(Boolean)
        .join("\n\n");
      expect(injected).toBe(envelope.renderedContext);
      expect(envelope.budget.used).toBe(
        // The guide is scaffolding, not memory: it lives in the overhead.
        persona!.tokenCost + envelope.budget.renderOverhead,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops the persona into excluded when the budget cannot hold it", async () => {
    const dir = sandboxWithPersona();
    try {
      const result = await recallIn(dir, 1);
      // Nothing fits, so nothing is injected — and the caller gets no context
      // rather than a guide-only context.
      expect(result?.prependContext).toBeUndefined();
      expect(result?.appendSystemContext).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
