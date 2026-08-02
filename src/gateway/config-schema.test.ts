/**
 * P1 — wave config schema: strict zod validation on new `memory` sections
 * (consolidation / nightRun / cleanup / probe / recall.typeWeights), fail-loud
 * on unknown keys, legacy recall keys stay alive (NOT strict on memory.recall).
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import { parseConfig } from "../config.js";

describe("wave config schema (P1)", () => {
  it("zero-config yields the documented defaults for new sections", () => {
    const cfg = parseConfig({});
    // consolidation
    expect(cfg.consolidation.enabled).toBe(false);
    expect(cfg.consolidation.model).toBe("opencode-go/deepseek-v4-flash");
    expect(cfg.consolidation.piBinary).toBe("pi");
    expect(cfg.consolidation.spawnFlags).toEqual(["-p", "--no-context-files", "--no-session"]);
    expect(cfg.consolidation.thinking).toBe("low");
    expect(cfg.consolidation.timeoutMs).toBe(600_000);
    expect(cfg.consolidation.diffCap).toBe(20);
    expect(cfg.consolidation.diffByteCap).toBe(8192);
    expect(cfg.consolidation.killPolicy).toBe("group-kill");
    // nightRun
    expect(cfg.nightRun.schedule).toBe("06:00");
    expect(cfg.nightRun.threshold).toBe(50);
    expect(cfg.nightRun.timezone).toBe("system");
    // cleanup
    expect(cfg.cleanup.enabled).toBe(true);
    expect(cfg.cleanup.intervalHours).toBe(24);
    expect(cfg.cleanup.paths).toEqual(["logs", "scratch"]);
    // probe
    expect(cfg.probe.corpusPath).toBe("probe-corpus.json");
    expect(cfg.probe.precisionTarget).toBe(0.9);
    expect(cfg.probe.topK).toBe(3);
    // typeWeights — off by default (all 1.0)
    expect(cfg.recall.typeWeights).toEqual({ instruction: 1, persona: 1, episodic: 1 });
  });

  it("parses a full valid config with every new section populated", () => {
    const cfg = parseConfig({
      consolidation: {
        enabled: true,
        model: "acme/some-model",
        piBinary: "~/bin/pi",
        spawnFlags: ["-p"],
        thinking: "high",
        timeoutMs: 120_000,
        diffCap: 10,
        diffByteCap: 4096,
        killPolicy: "sweep",
      },
      nightRun: { schedule: "03:30", threshold: 10, timezone: "Europe/Moscow" },
      cleanup: { enabled: false, intervalHours: 12, paths: ["a", "b"] },
      probe: { corpusPath: "~/corpus.json", precisionTarget: 0.8, topK: 5 },
      recall: { typeWeights: { instruction: 1.2, persona: 1.1, episodic: 0.9 } },
    });
    expect(cfg.consolidation.enabled).toBe(true);
    expect(cfg.consolidation.model).toBe("acme/some-model");
    expect(cfg.consolidation.killPolicy).toBe("sweep");
    expect(cfg.nightRun.schedule).toBe("03:30");
    expect(cfg.nightRun.threshold).toBe(10);
    expect(cfg.nightRun.timezone).toBe("Europe/Moscow");
    expect(cfg.cleanup.enabled).toBe(false);
    expect(cfg.cleanup.paths).toEqual(["a", "b"]);
    expect(cfg.probe.precisionTarget).toBe(0.8);
    expect(cfg.probe.topK).toBe(5);
    expect(cfg.recall.typeWeights.instruction).toBe(1.2);
  });

  it("expands a leading ~ in piBinary and probe.corpusPath", () => {
    const cfg = parseConfig({
      consolidation: { piBinary: "~/bin/pi" },
      probe: { corpusPath: "~/probe.json" },
    });
    const home = process.env.HOME ?? os.homedir();
    expect(cfg.consolidation.piBinary).toBe(`${home}/bin/pi`);
    expect(cfg.probe.corpusPath).toBe(`${home}/probe.json`);
  });

  it("fails loud on an unknown key inside consolidation", () => {
    expect(() => parseConfig({ consolidation: { bogus: 1 } })).toThrow(
      /Config validation failed \(memory\.consolidation\): unknown key\(s\) \[bogus\]/,
    );
  });

  it("fails loud on an unknown key inside recall.typeWeights", () => {
    expect(() => parseConfig({ recall: { typeWeights: { instruction: 1.0, bogus: 2 } } })).toThrow(
      /memory\.recall\.typeWeights.*bogus/,
    );
  });

  it("fails loud on an unknown key inside nightRun / cleanup / probe", () => {
    expect(() => parseConfig({ nightRun: { extra: true } })).toThrow(/memory\.nightRun.*extra/);
    expect(() => parseConfig({ cleanup: { nope: 1 } })).toThrow(/memory\.cleanup.*nope/);
    expect(() => parseConfig({ probe: { alsoNope: 1 } })).toThrow(/memory\.probe.*alsoNope/);
  });

  it("fails loud on an invalid value type in a new section", () => {
    expect(() => parseConfig({ nightRun: { schedule: "25:99" } })).toThrow(/memory\.nightRun/);
    expect(() => parseConfig({ consolidation: { timeoutMs: -5 } })).toThrow(/memory\.consolidation/);
    expect(() => parseConfig({ probe: { precisionTarget: 1.5 } })).toThrow(/memory\.probe/);
  });

  it("keeps legacy recall keys alive — memory.recall is NOT strict", () => {
    const cfg = parseConfig({
      recall: { scoreThreshold: 0.85, maxResults: 3, strategy: "embedding" },
    });
    expect(cfg.recall.scoreThreshold).toBe(0.85);
    expect(cfg.recall.maxResults).toBe(3);
    expect(cfg.recall.strategy).toBe("embedding");
    // typeWeights untouched → defaults
    expect(cfg.recall.typeWeights.instruction).toBe(1);
  });

  it("keeps other legacy memory groups intact", () => {
    const cfg = parseConfig({
      capture: { enabled: true, l0l1RetentionDays: 180 },
      extraction: { maxMemoriesPerSession: 20 },
      embedding: { conflictRecallTopK: 7 },
    });
    expect(cfg.capture.l0l1RetentionDays).toBe(180);
    expect(cfg.extraction.maxMemoriesPerSession).toBe(20);
    expect(cfg.embedding.conflictRecallTopK).toBe(7);
  });
});
