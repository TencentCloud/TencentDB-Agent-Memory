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
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";

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

/** A store whose rows carry no record id — what TCVDB returns (tcvdb.ts:1509). */
function storeWithoutRecordIds(contents: string[]): IMemoryStore {
  const rows: L1FtsResult[] = contents.map((content) => ({
    record_id: "",
    content,
    type: "instruction",
    priority: 50,
    scene_name: "s",
    score: 0.9,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "cc-test",
    session_id: "cc-test",
    metadata_json: "{}",
    project_id: "",
    scope: "global",
  }));
  return {
    isFtsAvailable: () => true,
    searchL1Fts: async () => rows,
  } as unknown as IMemoryStore;
}

describe("recall shell: text projects the envelope", () => {
  it("keeps two id-less memories apart instead of collapsing them into one line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz10b-noid-"));
    try {
      const result = await performAutoRecall({
        userText: "деплой",
        actorId: "u",
        sessionKey: "cc-test",
        cfg: parseConfig({ recall: { strategy: "keyword" } }),
        pluginDataDir: dir,
        vectorStore: storeWithoutRecordIds([
          "деплой идёт через rsync без --delete",
          "деплой прода только после подтверждения",
        ]),
      });
      const included = result!.envelope!.included.filter(
        (i) => i.kind === "l1",
      );
      expect(included).toHaveLength(2);
      // Distinct AND non-empty: an empty id is not an identity, and the
      // envelope promises every included element can be named.
      expect(new Set(included.map((i) => i.memoryId)).size).toBe(2);
      expect(included.every((i) => i.memoryId.length > 0)).toBe(true);
      for (const item of included) {
        expect(result!.prependContext).toContain(item.content);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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
